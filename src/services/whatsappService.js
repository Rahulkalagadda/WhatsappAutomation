const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const config = require('../config');
const { sleep, randomIntInclusive } = require('../utils/delay');

const LOG = '[WhatsApp-Pro]';

/** @typedef {'disconnected'|'initializing'|'qr_pending'|'authenticated'|'ready'|'error'|'reconnecting'} ConnState */

class WhatsAppManager {
  constructor() {
    this.client = null;
    this.connState = 'disconnected';
    this.lastQrDataUrl = null;
    this.lastError = null;
    this.sendInProgress = false;
    this.stopRequested = false;
    this.messageCountSinceRestart = 0;
    this.lastSendStats = {
      startedAt: null,
      finishedAt: null,
      total: 0,
      sent: 0,
      failed: 0,
      truncated: 0,
      testMode: false,
      errors: [],
      currentIndex: 0, // Checkpoint resume support
    };
  }

  logInfo(...args) { console.log(LOG, ...args); }
  logWarn(...args) { console.warn(LOG, ...args); }
  logError(...args) { console.error(LOG, ...args); }

  setConnState(next) {
    this.connState = next;
    this.logInfo('state →', next);
  }

  /**
   * Watchdog to monitor page health and detect silent crashes.
   */
  async checkHealth() {
    if (!this.client || !this.client.pupPage) return false;
    try {
      // Check if browser is still connected
      if (this.client.pupBrowser && !this.client.pupBrowser.isConnected()) return false;
      // Ping the context
      await this.client.pupPage.evaluate(() => window.WWebJS !== undefined);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Full destructive rebuild of the browser and client instance.
   * Essential for recovering from "Detached Frame" errors.
   */
  async rebuildClient() {
    this.logWarn('CRITICAL: Page instability detected. Initiating FULL client rebuild...');
    
    // 1. Cleanup current instance
    try {
      if (this.client) {
        await this.client.destroy();
      }
    } catch (e) {
      this.logWarn('Cleanup error during rebuild (ignored):', e.message);
    } finally {
      this.client = null;
      this.setConnState('disconnected');
    }

    await sleep(3000);

    // 2. Initialize fresh
    await this.initializeClient();

    // 3. Block until READY or TIMEOUT
    let timeout = 120; // 2 minutes for full boot and auth
    while (this.connState !== 'ready' && timeout > 0) {
      if (this.connState === 'qr_pending') {
        this.logError('REBUILD FAILED: Session lost. Scan QR code to resume.');
        throw new Error('REBUILD_AUTH_REQUIRED');
      }
      await sleep(1000);
      timeout--;
    }

    if (this.connState !== 'ready') {
      throw new Error('REBUILD_TIMEOUT');
    }

    this.logInfo('SUCCESS: Client rebuilt and recovered.');
    this.messageCountSinceRestart = 0;
  }

  async antiSleep() {
    if (!this.client || !this.client.pupPage) return;
    try {
      await this.client.pupPage.mouse.move(randomIntInclusive(0, 500), randomIntInclusive(0, 500));
      // Subtle click in a safe area to keep DOM active
      await this.client.pupPage.mouse.click(1, 1);
    } catch (e) {}
  }

  attachClientListeners(c) {
    c.on('qr', async (qr) => {
      try {
        this.lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 256 });
        this.setConnState('qr_pending');
        this.logInfo('QR code generated. Scan required.');
      } catch (e) {
        this.logError('QR generation error:', e.message);
      }
    });

    c.on('authenticated', () => {
      this.setConnState('authenticated');
      this.logInfo('Session authenticated.');
    });

    c.on('ready', () => {
      this.setConnState('ready');
      this.lastQrDataUrl = null;
      this.logInfo('WhatsApp Ready. User:', c.info?.pushname || 'Authenticated');
    });

    c.on('auth_failure', (msg) => {
      this.lastError = String(msg);
      this.setConnState('error');
      this.logError('Auth Failure:', msg);
    });

    c.on('disconnected', async (reason) => {
      this.logWarn('Client disconnected:', reason);
      this.setConnState('disconnected');
      // If we're in the middle of a send, the loop will detect this and trigger rebuild
    });
  }

  async initializeClient() {
    this.setConnState('initializing');
    
    this.client = new Client({
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
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--js-flags="--max-old-space-size=4096"', // Memory optimization
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
      this.logError('Init failed:', err.message);
      this.setConnState('error');
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

  async sendOne(chatId, message) {
    if (config.testMode) return { ok: true, testMode: true };

    const isHealthy = await this.checkHealth();
    if (!isHealthy || this.connState !== 'ready') {
      throw new Error('STALE_CONTEXT');
    }

    await this.antiSleep();

    // Attempt operation with explicit error catching for detachment and resolution failures
    try {
      const number = chatId.split('@')[0];
      let target = chatId;
      
      try {
        const contactId = await this.client.getNumberId(number);
        if (contactId?._serialized) {
          target = contactId._serialized;
        }
      } catch (idErr) {
        // Fallback: if ID resolution fails with "No LID", it might be an invalid number
        // but we'll still try to send directly to the chatId as a last resort.
        this.logWarn(`ID resolution failed for ${chatId}: ${idErr.message}. Trying direct send...`);
      }
      
      await this.client.sendMessage(target, message);
      this.messageCountSinceRestart++;
      return { ok: true };
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('detached') || msg.includes('context destroyed') || msg.includes('Protocol error')) {
        throw new Error('STALE_CONTEXT');
      }
      if (msg.includes('No LID') || msg.includes('wid')) {
        throw new Error(`Invalid Number: This contact (${chatId.split('@')[0]}) does not appear to be on WhatsApp.`);
      }
      throw e;
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
    this.sendInProgress = true;
    this.stopRequested = false;

    const normalizedRecipients = Array.isArray(recipients) && recipients.length
      ? recipients.map((r) => ({ chatId: r.chatId, variables: r.variables || {} }))
      : (numbers || []).map((chatId) => ({ chatId, variables: {} }));

    const toProcess = normalizedRecipients.slice(0, maxBatch);
    
    this.lastSendStats = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total: toProcess.length,
      sent: 0,
      failed: 0,
      truncated: normalizedRecipients.length - toProcess.length,
      testMode: config.testMode,
      errors: [],
      currentIndex: 0,
    };

    try {
      for (let i = 0; i < toProcess.length; i++) {
        this.lastSendStats.currentIndex = i;
        if (this.stopRequested) break;

        // Periodic Memory Cleanup: Restart browser every 25 messages to stay fresh
        if (this.messageCountSinceRestart >= 25) {
          this.logInfo('Performing scheduled memory cleanup (client restart)...');
          await this.rebuildClient();
        }

        const { chatId, variables } = toProcess[i];
        const resolvedMessage = this.renderMessageTemplate(message, variables);

        try {
          await this.sendOne(chatId, resolvedMessage);
          this.lastSendStats.sent++;
          this.logInfo(`[${i + 1}/${toProcess.length}] OK: ${chatId}`);
        } catch (e) {
          if (e.message === 'STALE_CONTEXT' || e.message.includes('detached')) {
            this.logWarn(`Detached frame detected at ${chatId}. Triggering REBUILD...`);
            try {
              await this.rebuildClient();
              i--; // Retry the same contact
              continue;
            } catch (rebuildErr) {
              this.logError('REBUILD FAILED FATALLY:', rebuildErr.message);
              this.lastSendStats.errors.push({ chatId, error: 'Browser crashed and failed to rebuild' });
              break; 
            }
          }

          this.lastSendStats.failed++;
          this.lastSendStats.errors.push({ chatId, error: e.message });
          this.logError(`[${i + 1}/${toProcess.length}] FAIL: ${chatId} - ${e.message}`);
        }

        // Delay between messages
        if (i < toProcess.length - 1 && !this.stopRequested) {
          const delay = randomIntInclusive(15000, 30000);
          await sleep(delay);
        }
      }
    } finally {
      this.sendInProgress = false;
      this.lastSendStats.finishedAt = new Date().toISOString();
      this.logInfo(`Job Finished. Sent: ${this.lastSendStats.sent}, Failed: ${this.lastSendStats.failed}`);
    }

    return this.lastSendStats;
  }

  cancelBulkJob() {
    this.stopRequested = true;
    return true;
  }

  forceResetLock() {
    this.sendInProgress = false;
    this.stopRequested = false;
    return true;
  }
}

const manager = new WhatsAppManager();
manager.initializeClient();

module.exports = {
  initializeClient: () => manager.initializeClient(),
  destroyClient: () => manager.destroyClient(),
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
  cancelBulkJob: () => manager.cancelBulkJob(),
  forceResetLock: () => manager.forceResetLock(),
  logoutAndReinitialize: () => manager.logoutAndReinitialize(),
  renderMessageTemplate: (t, v) => manager.renderMessageTemplate(t, v),
  sendBulkSequential: (p) => manager.sendBulkSequential(p),
};
