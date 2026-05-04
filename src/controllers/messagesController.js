const config = require('../config');
const { parsePhoneNumbersFromCsv } = require('../utils/csvParser');
const whatsappService = require('../services/whatsappService');

const LOG = '[Messages]';

/**
 * Shared: parse multipart body (message + csv buffer).
 */
async function parseCsvFromRequest(req) {
  const message = req.body?.message;
  const file = req.file;

  if (!message || !String(message).trim()) {
    const err = new Error('Field "message" is required');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!file || !file.buffer) {
    const err = new Error('Field "file" (CSV) is required');
    err.code = 'VALIDATION';
    throw err;
  }

  const { numbers, recipients, skipped, parseMeta } = await parsePhoneNumbersFromCsv(file.buffer);
  return {
    message: String(message),
    numbers,
    recipients,
    skipped,
    parseMeta,
    filename: file.originalname,
  };
}

/**
 * POST /messages/preview
 */
async function preview(req, res) {
  try {
    const { message, numbers, recipients, skipped, parseMeta, filename } = await parseCsvFromRequest(req);

    return res.json({
      ok: true,
      filename,
      messagePreview: message.slice(0, 500) + (message.length > 500 ? '…' : ''),
      count: numbers.length,
      numbers,
      parseWarnings: skipped,
      parseMeta,
      maxMessagesPerBatch: config.maxMessagesPerBatch,
      wouldTruncate: numbers.length > config.maxMessagesPerBatch,
    });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error(LOG, 'preview error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * POST /messages/send
 */
async function send(req, res) {
  /** Allow manual override if "force" is passed in query or body */
  const force = req.query?.force === 'true' || req.body?.force === 'true';
  if (force) {
    whatsappService.forceResetLock();
  }

  if (!whatsappService.acquireSendLock()) {
    return res.status(409).json({
      ok: false,
      error: 'A bulk send is already in progress. Use "force=true" to override.',
      code: 'SEND_IN_PROGRESS',
    });
  }

  try {
    const { message, numbers, recipients, skipped, parseMeta, filename } = await parseCsvFromRequest(req);

    if (numbers.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No valid phone numbers found in CSV',
        parseWarnings: skipped,
      });
    }

    const status = whatsappService.getAuthStatus();
    if (!status.connected && !config.testMode) {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client is not connected. Scan QR via GET /auth/qr first.',
        state: status.state,
      });
    }

    const summary = await whatsappService.sendBulkSequential({
      numbers,
      recipients,
      message,
      maxBatch: config.maxMessagesPerBatch,
    });

    return res.json({
      ok: true,
      filename,
      parseWarnings: skipped,
      parseMeta,
      summary,
      lastSendStats: whatsappService.getLastSendStats(),
    });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error(LOG, 'send error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    whatsappService.releaseSendLock();
  }
}

/**
 * GET /messages/last-stats — bonus: expose last job counters.
 */
function lastStats(_req, res) {
  return res.json({
    ok: true,
    lastSend: whatsappService.getLastSendStats(),
    sendInProgress: whatsappService.isSendLocked(),
  });
}

/**
 * POST /messages/cancel
 */
function cancel(_req, res) {
  const stopped = whatsappService.cancelBulkJob();
  return res.json({
    ok: true,
    stopped,
    message: stopped ? 'Bulk campaign stopped.' : 'No active campaign to stop.',
  });
}

/**
 * POST /messages/reset
 */
function reset(_req, res) {
  whatsappService.forceResetLock();
  return res.json({
    ok: true,
    message: 'Bulk job lock has been force-reset.',
  });
}

module.exports = {
  preview,
  send,
  lastStats,
  cancel,
  reset,
};
