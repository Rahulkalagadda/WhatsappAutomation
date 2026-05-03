const whatsappService = require('../services/whatsappService');

/**
 * GET /auth/qr — latest QR as base64 PNG (raw, without data: prefix).
 */
function getQr(req, res) {
  try {
    const status = whatsappService.getAuthStatus();
    const dataUrl = whatsappService.getQrDataUrl();

    if (status.connected) {
      return res.json({
        ok: true,
        connected: true,
        qrBase64: null,
        message: 'Client is already connected; no QR needed.',
      });
    }

    if (!dataUrl) {
      return res.json({
        ok: true,
        connected: false,
        state: status.state,
        qrBase64: null,
        message:
          'QR not available yet. Wait for initialization or check /auth/status.',
      });
    }

    const qrBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

    return res.json({
      ok: true,
      connected: false,
      state: status.state,
      qrBase64,
      /** Convenience for HTML: <img src="..."> */
      dataUrl,
    });
  } catch (err) {
    console.error('[Auth]', err);
    return res.status(500).json({ ok: false, error: 'Failed to read QR state' });
  }
}

/**
 * GET /auth/status
 */
function getStatus(_req, res) {
  const s = whatsappService.getAuthStatus();
  return res.json({
    ok: true,
    connected: s.connected,
    state: s.state,
    user: s.user,
    lastError: s.lastError,
  });
}

/**
 * POST /auth/logout — remote logout + destroy + re-init client.
 */
async function logout(_req, res) {
  try {
    await whatsappService.logoutAndReinitialize();
    return res.json({
      ok: true,
      message: 'Logged out locally and from device (if applicable). Client reinitialized.',
    });
  } catch (err) {
    console.error('[Auth] logout error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  getQr,
  getStatus,
  logout,
};
