/**
 * Centralized environment configuration with sane defaults.
 */
const path = require('path');
require('dotenv').config();

const toBool = (value, defaultValue = false) => {
  if (value === undefined || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true' || value === '1';
};

const toInt = (value, fallback) => {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
};

const frontendDist = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : path.join(__dirname, '..', '..', 'frontend', 'dist');

module.exports = {
  port: toInt(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  /** Dry-run: parse CSV and log without sending */
  testMode: toBool(process.env.TEST_MODE, false),
  /** Maximum recipients per send batch */
  maxMessagesPerBatch: Math.max(1, toInt(process.env.MAX_MESSAGES_PER_BATCH, 100)),
  /** Optional LocalAuth clientId for isolated session folders */
  whatsappClientId: process.env.WHATSAPP_CLIENT_ID || 'default',
  /** Vite/React production build (served when folder exists) */
  frontendDist,
};
