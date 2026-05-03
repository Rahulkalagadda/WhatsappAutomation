const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const healthRoutes = require('./routes/healthRoutes');
const authRoutes = require('./routes/authRoutes');
const messagesRoutes = require('./routes/messagesRoutes');

/**
 * Express application factory — keeps index.js focused on HTTP server boot.
 */
function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Request logging (skip chatty polling endpoints from the dashboard).
  app.use((req, _res, next) => {
    const p = req.path;
    const isPollingEndpoint =
      req.method === 'GET' &&
      (p === '/auth/status' || p === '/messages/last-stats' || p === '/health');

    if (!isPollingEndpoint) {
      console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
    }
    next();
  });

  app.use(healthRoutes);
  app.use(authRoutes);
  app.use(messagesRoutes);

  /** Production UI: serve Vite build if present */
  const dist = config.frontendDist;
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false }));
    // After static: HTML shell for browser navigation (skip API + hashed Vite assets)
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const p = req.path.split('?')[0];
      if (
        p.startsWith('/auth') ||
        p.startsWith('/messages') ||
        p === '/health' ||
        p.startsWith('/assets/')
      ) {
        return next();
      }
      const indexFile = path.join(dist, 'index.html');
      res.sendFile(indexFile, (err) => (err ? next(err) : undefined));
    });
  }

  // 404
  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  // Central error handler (multer + unexpected)
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[HTTP] unhandled error:', err);
    if (err.name === 'MulterError') {
      return res.status(400).json({ ok: false, error: err.message });
    }
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  });

  return app;
}

module.exports = { createApp };
