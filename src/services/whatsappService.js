const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const config = require('../config');
const { sleep, randomIntInclusive } = require('../utils/delay');

const LOG = '[WhatsApp]';

/** @typedef {'disconnected'|'initializing'|'qr_pending'|'authenticated'|'ready'|'error'} ConnState */

let client = null;
/** @type {ConnState} */
let connState = 'disconnected';
let lastQrDataUrl = null;
let lastError = null;
let sendInProgress = false;

/** Stats for the most recent bulk send job */
let lastSendStats = {
  startedAt: null,
  finishedAt: null,
  total: 0,
  sent: 0,
  failed: 0,
  truncated: 0,
  testMode: false,
  errors: [],
};

function logInfo(...args) {
  console.log(LOG, ...args);
}

function logWarn(...args) {
  console.warn(LOG, ...args);
}

function logError(...args) {
  console.error(LOG, ...args);
}

function getLastSendStats() {
  return { ...lastSendStats, errors: [...lastSendStats.errors] };
}

function setConnState(next) {
  connState = next;
  logInfo('state →', next);
}

/**
 * Wire client lifecycle listeners (QR, ready, disconnect, etc.).
 * @param {import('whatsapp-web.js').Client} c
 */
function attachClientListeners(c) {
  c.on('qr', async (qr) => {
    try {
      lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 256 });
      setConnState('qr_pending');
      logInfo('QR generated; scan from GET /auth/qr');
    } catch (e) {
      logError('Failed to render QR image:', e.message);
      lastQrDataUrl = null;
    }
  });

  c.on('authenticated', () => {
    setConnState('authenticated');
    logInfo('session authenticated');
  });

  c.on('ready', () => {
    setConnState('ready');
    lastQrDataUrl = null;
    logInfo('client ready as', c.info?.pushname || c.info?.wid?.user || 'unknown');
  });

  c.on('auth_failure', (msg) => {
    lastError = String(msg);
    setConnState('error');
    logError('auth_failure:', msg);
  });

  c.on('disconnected', (reason) => {
    logWarn('disconnected:', reason);
    lastQrDataUrl = null;
    setConnState('disconnected');
  });

  c.on('change_state', (s) => {
    logInfo('puppeteer state:', s);
  });
}

/**
 * Create and initialize the singleton WhatsApp client (non-blocking).
 */
function initializeClient() {
  if (client) {
    logInfo('initialize skipped: client already exists');
    return;
  }

  setConnState('initializing');
  lastError = null;

  client = new Client({
    authStrategy: new LocalAuth({ clientId: config.whatsappClientId }),
    puppeteer: {
      headless: false,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  attachClientListeners(client);

  client.initialize().catch((err) => {
    lastError = err.message;
    setConnState('error');
    logError('initialize failed:', err);
  });
}

/**
 * Destroy current client instance (used by logout / hard reset).
 * @returns {Promise<void>}
 */
async function destroyClient() {
  if (!client) return;
  try {
    await client.destroy();
  } catch (e) {
    logWarn('destroy error (ignored):', e.message);
  } finally {
    client = null;
    setConnState('disconnected');
    lastQrDataUrl = null;
  }
}

/**
 * Log out from WhatsApp, wipe local session, and boot a fresh client.
 * @returns {Promise<void>}
 */
async function logoutAndReinitialize() {
  logInfo('logout requested');
  if (client) {
    try {
      await client.logout();
    } catch (e) {
      logWarn('logout() failed (continuing with destroy):', e.message);
    }
  }
  await destroyClient();
  initializeClient();
}

/**
 * Public status for HTTP layer.
 */
function getAuthStatus() {
  const connected = connState === 'ready';
  return {
    connected,
    state: connState,
    user: connected && client?.info
      ? {
          wid: client.info.wid?._serialized,
          pushname: client.info.pushname,
        }
      : null,
    lastError,
  };
}

/**
 * Latest QR as base64 data URL (or null if not applicable).
 */
function getQrDataUrl() {
  return lastQrDataUrl;
}

/**
 * Whether a bulk job is currently running.
 */
function isSendLocked() {
  return sendInProgress;
}

/**
 * Atomically acquire the send lock (prevents overlapping batches).
 * @returns {boolean} true if acquired
 */
function acquireSendLock() {
  if (sendInProgress) return false;
  sendInProgress = true;
  return true;
}

function releaseSendLock() {
  sendInProgress = false;
}

/**
 * Replace {{variable}} placeholders using recipient variables (case-insensitive keys).
 * Unknown variables are left unchanged.
 *
 * @param {string} template
 * @param {Record<string, string>} variables
 * @returns {string}
 */
function renderMessageTemplate(template, variables) {
  const map = Object.entries(variables || {}).reduce((acc, [k, v]) => {
    acc[String(k).toLowerCase()] = v == null ? '' : String(v);
    return acc;
  }, {});

  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const val = map[String(key).toLowerCase()];
    return val === undefined ? match : val;
  });
}

/**
 * Send one message with ID resolution fallback.
 */
async function sendOne(chatId, message) {
  if (config.testMode) {
    logInfo(`[TEST_MODE] would send to ${chatId}:`, message.slice(0, 80) + (message.length > 80 ? '…' : ''));
    return { ok: true, testMode: true };
  }
  if (!client || connState !== 'ready') {
    throw new Error('WhatsApp client is not ready');
  }

  let targetId = chatId;
  try {
    const number = chatId.split('@')[0];
    const contactId = await client.getNumberId(number);
    if (contactId && contactId._serialized) {
      targetId = contactId._serialized;
      logInfo(`Resolved ID for ${number} → ${targetId}`);
    } else {
      logWarn(`Could not resolve official ID for ${number}, attempting direct send to ${chatId}`);
    }
  } catch (e) {
    logWarn(`ID resolution error for ${chatId}:`, e.message);
  }

  await client.sendMessage(targetId, message);
  return { ok: true, testMode: false };
}

// Global safety net to prevent backend crashes
process.on('unhandledRejection', (reason, promise) => {
  logError('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  logError('Uncaught Exception:', err);
});

/**
 * Sequential bulk send with 20–25s jitter between messages.
 *
 * @param {{
 *   numbers?: string[],
 *   recipients?: { chatId: string, variables?: Record<string, string> }[],
 *   message: string,
 *   maxBatch: number
 * }} params
 * @returns {Promise<object>} summary
 */
async function sendBulkSequential({ numbers, recipients, message, maxBatch }) {
  const startedAt = new Date().toISOString();
  const errors = [];
  let sent = 0;
  let failed = 0;
  let truncated = 0;

  const normalizedRecipients = Array.isArray(recipients) && recipients.length
    ? recipients.map((r) => ({
      chatId: r.chatId,
      variables: r.variables || {},
    }))
    : (numbers || []).map((chatId) => ({ chatId, variables: {} }));

  let toProcess = normalizedRecipients;
  if (normalizedRecipients.length > maxBatch) {
    truncated = normalizedRecipients.length - maxBatch;
    toProcess = normalizedRecipients.slice(0, maxBatch);
    logWarn(`batch truncated: processing ${maxBatch} of ${normalizedRecipients.length} numbers`);
  }

  lastSendStats = {
    startedAt,
    finishedAt: null,
    total: toProcess.length,
    sent: 0,
    failed: 0,
    truncated,
    testMode: config.testMode,
    errors: [],
  };

  logInfo(
    `bulk send start | recipients=${toProcess.length} testMode=${config.testMode}`,
  );

  try {
    for (let i = 0; i < toProcess.length; i += 1) {
      const { chatId, variables } = toProcess[i];
      const resolvedMessage = renderMessageTemplate(message, variables);
      try {
        await sendOne(chatId, resolvedMessage);
        sent += 1;
        logInfo(`sent OK [${i + 1}/${toProcess.length}] → ${chatId}`);
      } catch (e) {
        failed += 1;
        const entry = { chatId, error: e.message };
        errors.push(entry);
        logWarn(`send FAIL [${i + 1}/${toProcess.length}] → ${chatId}:`, e.message);
      }

      lastSendStats.sent = sent;
      lastSendStats.failed = failed;
      lastSendStats.errors = [...errors];

      if (i < toProcess.length - 1) {
        const waitMs = randomIntInclusive(20_000, 25_000);
        logInfo(`throttle: waiting ${waitMs}ms before next message`);
        await sleep(waitMs);
      }
    }
  } finally {
    const finishedAt = new Date().toISOString();
    lastSendStats.finishedAt = finishedAt;
    lastSendStats.sent = sent;
    lastSendStats.failed = failed;
    lastSendStats.errors = [...errors];
    logInfo(`bulk send done | sent=${sent} failed=${failed} truncated=${truncated}`);
  }

  return {
    startedAt,
    finishedAt: lastSendStats.finishedAt,
    total: toProcess.length,
    sent,
    failed,
    truncated,
    testMode: config.testMode,
    errors,
  };
}

// Boot client on module load so QR is available quickly
initializeClient();

module.exports = {
  initializeClient,
  destroyClient,
  logoutAndReinitialize,
  getAuthStatus,
  getQrDataUrl,
  getLastSendStats,
  isSendLocked,
  acquireSendLock,
  releaseSendLock,
  renderMessageTemplate,
  sendBulkSequential,
};
