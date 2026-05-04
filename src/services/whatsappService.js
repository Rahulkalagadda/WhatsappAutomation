const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const config = require('../config');
const { sleep, randomIntInclusive } = require('../utils/delay');

const LOG = '[WhatsApp]';

/** @typedef {'disconnected'|'initializing'|'qr_pending'|'authenticated'|'ready'|'error'|'reconnecting'} ConnState */

class WhatsAppManager {
  constructor() {
    this.client = null;
    this.connState = 'disconnected';
    this.lastQrDataUrl = null;
    this.lastError = null;
    this.sendInProgress = false;
    this.lastSendStats = {
      startedAt: null,
      finishedAt: null,
      total: 0,
      sent: 0,
      failed: 0,
      truncated: 0,
      testMode: false,
      errors: [],
    };
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  logInfo(...args) { console.log(LOG, ...args); }
  logWarn(...args) { console.warn(LOG, ...args); }
  logError(...args) { console.error(LOG, ...args); }

  setConnState(next) {
    this.connState = next;
    this.logInfo('state →', next);
  }

  /**
   * Checks if the browser page is still alive and responsive.
   * This addresses the "detached frame" issue by verifying the execution context.
   */
  async ensurePageIsStable() {
    if (!this.client || !this.client.pupPage) return false;
    try {
      // Try a simple evaluation to see if the context is still valid
      await this.client.pupPage.evaluate(() => window.WWebJS !== undefined);
      return true;
    } catch (e) {
      this.logWarn('Page instability detected (detached frame or context destroyed). Recovering...');
      return false;
    }
  }

  /**
   * Anti-sleep/Keep-alive logic to prevent Chrome from throttling or sleeping
   */
  async antiSleep() {
    if (!this.client || !this.client.pupPage) return;
    try {
      await this.client.pupPage.mouse.move(randomIntInclusive(0, 100), randomIntInclusive(0, 100));
    } catch (e) {
      // Ignore mouse errors
    }
  }

  attachClientListeners(c) {
    c.on('qr', async (qr) => {
      try {
        this.lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 256 });
        this.setConnState('qr_pending');
        this.logInfo('QR generated; scan from GET /auth/qr');
      } catch (e) {
        this.logError('Failed to render QR image:', e.message);
        this.lastQrDataUrl = null;
      }
    });

    c.on('authenticated', () => {
      this.setConnState('authenticated');
      this.logInfo('session authenticated');
    });

    c.on('ready', () => {
      this.setConnState('ready');
      this.lastQrDataUrl = null;
      this.logInfo('client ready as', c.info?.pushname || c.info?.wid?.user || 'unknown');
    });

    c.on('auth_failure', (msg) => {
      this.lastError = String(msg);
      this.setConnState('error');
      this.logError('auth_failure:', msg);
    });

    c.on('disconnected', async (reason) => {
      this.logWarn('disconnected:', reason);
      this.lastQrDataUrl = null;
      this.setConnState('disconnected');
      
      // Auto-reconnect logic if it wasn't a deliberate logout
      if (reason !== 'NAVIGATION') {
        this.logInfo('Attempting auto-reconnect...');
        await this.initializeClient();
      }
    });

    c.on('change_state', (s) => {
      this.logInfo('puppeteer internal state:', s);
    });
  }

  async initializeClient() {
    if (this.client && (this.connState === 'ready' || this.connState === 'initializing')) {
      this.logInfo('initialize skipped: client already active');
      return;
    }

    this.setConnState('initializing');
    this.lastError = null;

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: config.whatsappClientId }),
      puppeteer: {
        headless: false, // Set to true for production if no UI is needed
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
        ],
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      },
    });

    this.attachClientListeners(this.client);

    try {
      await this.client.initialize();
    } catch (err) {
      this.lastError = err.message;
      this.setConnState('error');
      this.logError('initialize failed:', err);
    }
  }

  async destroyClient() {
    if (!this.client) return;
    try {
      await this.client.destroy();
    } catch (e) {
      this.logWarn('destroy error (ignored):', e.message);
    } finally {
      this.client = null;
      this.setConnState('disconnected');
      this.lastQrDataUrl = null;
    }
  }

  async logoutAndReinitialize() {
    this.logInfo('logout requested');
    if (this.client) {
      try {
        await this.client.logout();
      } catch (e) {
        this.logWarn('logout() failed (continuing with destroy):', e.message);
      }
    }
    await this.destroyClient();
    await this.initializeClient();
  }

  getAuthStatus() {
    const connected = this.connState === 'ready';
    return {
      connected,
      state: this.connState,
      user: connected && this.client?.info
        ? {
            wid: this.client.info.wid?._serialized,
            pushname: this.client.info.pushname,
          }
        : null,
      lastError: this.lastError,
    };
  }

  /**
   * Core function to send one message with massive reliability checks.
   */
  async sendOne(chatId, message) {
    if (config.testMode) {
      this.logInfo(`[TEST_MODE] would send to ${chatId}:`, message.slice(0, 80) + (message.length > 80 ? '…' : ''));
      return { ok: true, testMode: true };
    }

    // 1. Pre-flight check: Is the page stable?
    const stable = await this.ensurePageIsStable();
    if (!stable || !this.client || this.connState !== 'ready') {
      this.logWarn('Client not ready or page unstable. Waiting for recovery...');
      // Wait up to 30 seconds for 'ready' state
      let waited = 0;
      while (this.connState !== 'ready' && waited < 30) {
        await sleep(1000);
        waited++;
      }
      if (this.connState !== 'ready') throw new Error('WhatsApp client recovery timeout');
    }

    // 2. Anti-sleep move
    await this.antiSleep();

    // 3. Resolve Number ID (with retry for detached frames)
    let targetId = chatId;
    let retryAttempt = 0;
    const maxLocalRetries = 2;

    while (retryAttempt <= maxLocalRetries) {
      try {
        const number = chatId.split('@')[0];
        const contactId = await this.client.getNumberId(number);
        if (contactId && contactId._serialized) {
          targetId = contactId._serialized;
        } else {
          this.logWarn(`Unrecognized number: ${number}. Will attempt direct send.`);
        }
        break; // Success
      } catch (e) {
        if (e.message.includes('detached') || e.message.includes('context destroyed')) {
          this.logWarn(`Detached frame error during ID resolution for ${chatId}. Retry ${retryAttempt + 1}...`);
          await sleep(2000);
          retryAttempt++;
          if (retryAttempt > maxLocalRetries) throw e;
        } else {
          throw e;
        }
      }
    }

    // 4. Send Message (with retry for detached frames)
    retryAttempt = 0;
    while (retryAttempt <= maxLocalRetries) {
      try {
        await this.client.sendMessage(targetId, message);
        return { ok: true, testMode: false };
      } catch (e) {
        if (e.message.includes('detached') || e.message.includes('context destroyed')) {
          this.logWarn(`Detached frame error during send to ${chatId}. Retry ${retryAttempt + 1}...`);
          await sleep(2000);
          retryAttempt++;
          if (retryAttempt > maxLocalRetries) throw e;
        } else {
          throw e;
        }
      }
    }
  }

  renderMessageTemplate(template, variables) {
    const map = Object.entries(variables || {}).reduce((acc, [k, v]) => {
      acc[String(k).toLowerCase()] = v == null ? '' : String(v);
      return acc;
    }, {});

    return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      const val = map[String(key).toLowerCase()];
      return val === undefined ? match : val;
    });
  }

  async sendBulkSequential({ numbers, recipients, message, maxBatch }) {
    if (this.sendInProgress) throw new Error('Another bulk job is already in progress');
    this.sendInProgress = true;

    const startedAt = new Date().toISOString();
    const errors = [];
    let sent = 0;
    let failed = 0;

    const normalizedRecipients = Array.isArray(recipients) && recipients.length
      ? recipients.map((r) => ({ chatId: r.chatId, variables: r.variables || {} }))
      : (numbers || []).map((chatId) => ({ chatId, variables: {} }));

    let toProcess = normalizedRecipients.slice(0, maxBatch);
    const truncated = normalizedRecipients.length > maxBatch ? normalizedRecipients.length - maxBatch : 0;

    this.lastSendStats = {
      startedAt,
      finishedAt: null,
      total: toProcess.length,
      sent: 0,
      failed: 0,
      truncated,
      testMode: config.testMode,
      errors: [],
    };

    this.logInfo(`Bulk campaign started: ${toProcess.length} contacts.`);

    try {
      for (let i = 0; i < toProcess.length; i++) {
        const { chatId, variables } = toProcess[i];
        const resolvedMessage = this.renderMessageTemplate(message, variables);

        try {
          await this.sendOne(chatId, resolvedMessage);
          sent++;
          this.logInfo(`[${i + 1}/${toProcess.length}] SENT: ${chatId}`);
        } catch (e) {
          failed++;
          errors.push({ chatId, error: e.message });
          this.logError(`[${i + 1}/${toProcess.length}] FAIL: ${chatId} - ${e.message}`);
          
          // If internet is lost, wait indefinitely until restored
          if (e.message.includes('network') || e.message.includes('internet')) {
            this.logWarn('Internet loss detected. Pausing campaign...');
            while (!(await this.ensurePageIsStable())) {
              await sleep(5000);
            }
            this.logInfo('Internet/Page restored. Resuming...');
            i--; // Retry this one
            failed--;
            errors.pop();
            continue;
          }
        }

        // Update stats in real-time
        this.lastSendStats.sent = sent;
        this.lastSendStats.failed = failed;
        this.lastSendStats.errors = [...errors];

        // Random human-like delay between messages
        if (i < toProcess.length - 1) {
          const delay = randomIntInclusive(15000, 35000); // 15-35 seconds
          this.logInfo(`Waiting ${Math.round(delay/1000)}s for anti-spam throttle...`);
          await sleep(delay);
        }
      }
    } finally {
      this.sendInProgress = false;
      this.lastSendStats.finishedAt = new Date().toISOString();
      this.logInfo(`Campaign finished. Total: ${toProcess.length}, Sent: ${sent}, Failed: ${failed}`);
    }

    return this.lastSendStats;
  }
}

// Singleton instance
const manager = new WhatsAppManager();

// Auto-initialize on start
manager.initializeClient();

module.exports = {
  initializeClient: () => manager.initializeClient(),
  destroyClient: () => manager.destroyClient(),
  logoutAndReinitialize: () => manager.logoutAndReinitialize(),
  getAuthStatus: () => manager.getAuthStatus(),
  getQrDataUrl: () => manager.lastQrDataUrl,
  getLastSendStats: () => manager.lastSendStats,
  isSendLocked: () => manager.sendInProgress,
  acquireSendLock: () => {
    if (manager.sendInProgress) return false;
    manager.sendInProgress = true;
    return true;
  },
  releaseSendLock: () => { manager.sendInProgress = false; },
  renderMessageTemplate: (t, v) => manager.renderMessageTemplate(t, v),
  sendBulkSequential: (p) => manager.sendBulkSequential(p),
};
