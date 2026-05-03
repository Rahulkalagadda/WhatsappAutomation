const config = require('../config');

/**
 * GET /health — liveness for load balancers & ops.
 */
function health(_req, res) {
  res.json({
    ok: true,
    service: 'whatsapp-bulk-backend',
    uptimeSeconds: Math.round(process.uptime()),
    env: config.nodeEnv,
    testMode: config.testMode,
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  health,
};
