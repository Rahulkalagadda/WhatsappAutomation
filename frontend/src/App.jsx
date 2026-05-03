import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchAuthQr,
  fetchAuthStatus,
  fetchHealth,
  fetchLastStats,
  postLogout,
  postPreview,
  postSend,
} from './api.js';

function Pill({ tone, children }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [auth, setAuth] = useState(null);
  const [qrPayload, setQrPayload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [lastStats, setLastStats] = useState(null);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  const showError = useCallback((err) => {
    const text = err?.message || 'Something went wrong';
    setBanner({ type: 'error', text });
  }, []);

  const showSuccess = useCallback((text) => {
    setBanner({ type: 'success', text });
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await fetchHealth();
      setHealth(h);
    } catch {
      setHealth(null);
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const s = await fetchAuthStatus();
      setAuth(s);
    } catch (e) {
      setAuth(null);
      showError(e);
    }
  }, [showError]);

  const refreshQr = useCallback(async () => {
    try {
      const q = await fetchAuthQr();
      setQrPayload(q);
    } catch (e) {
      setQrPayload(null);
      showError(e);
    }
  }, [showError]);

  const refreshLastStats = useCallback(async () => {
    try {
      const s = await fetchLastStats();
      setLastStats(s);
    } catch {
      setLastStats(null);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 30000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  useEffect(() => {
    refreshAuth();
    const t = setInterval(refreshAuth, 3000);
    return () => clearInterval(t);
  }, [refreshAuth]);

  useEffect(() => {
    refreshLastStats();
    const t = setInterval(refreshLastStats, 2000);
    return () => clearInterval(t);
  }, [refreshLastStats]);

  useEffect(() => {
    if (!auth?.connected) {
      refreshQr();
    } else {
      setQrPayload(null);
    }
  }, [auth?.connected, auth?.state, refreshQr]);

  const qrSrc = useMemo(() => {
    if (!qrPayload) return null;
    if (qrPayload.dataUrl) return qrPayload.dataUrl;
    if (qrPayload.qrBase64) {
      return `data:image/png;base64,${qrPayload.qrBase64}`;
    }
    return null;
  }, [qrPayload]);

  const buildFormData = useCallback(() => {
    const fd = new FormData();
    fd.append('message', message);
    if (file) fd.append('file', file);
    return fd;
  }, [message, file]);

  const onPreview = async () => {
    setBanner(null);
    if (!file) {
      showError(new Error('Choose a CSV file first'));
      return;
    }
    if (!message.trim()) {
      showError(new Error('Enter a message'));
      return;
    }
    setBusy(true);
    try {
      const data = await postPreview(buildFormData());
      setPreview(data);
      const m = data.parseMeta;
      const extra =
        m && (m.csvRowsRead > 0 || m.duplicateNumbersInFile > 0)
          ? ` · ${m.csvRowsRead} data row(s) in file` +
            (m.duplicateNumbersInFile
              ? `, ${m.duplicateNumbersInFile} duplicate(s) merged`
              : '') +
            (m.separator ? ` · delimiter “${m.separator === '\t' ? 'tab' : m.separator}”` : '')
          : '';
      showSuccess(`Parsed ${data.count} unique number(s) — ${data.count} message(s) will be sent.${extra}`);
    } catch (e) {
      showError(e);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const onSend = async () => {
    setBanner(null);
    if (!file) {
      showError(new Error('Choose a CSV file first'));
      return;
    }
    if (!message.trim()) {
      showError(new Error('Enter a message'));
      return;
    }
    if (
      !window.confirm(
        'Start bulk send? Messages go out one-by-one with 20–25s delay between each.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const data = await postSend(buildFormData());
      const sum = data.summary;
      showSuccess(
        `Done: sent ${sum.sent}, failed ${sum.failed}` +
          (sum.truncated ? `, truncated ${sum.truncated}` : ''),
      );
      setPreview(null);
      await refreshLastStats();
    } catch (e) {
      if (e.status === 503) {
        showError(
          new Error(
            'WhatsApp is not connected. Scan the QR code in the left panel (or enable TEST_MODE on the server).',
          ),
        );
      } else if (e.status === 409) {
        showError(new Error('Another send is already running. Wait and try again.'));
      } else {
        showError(e);
      }
    } finally {
      setBusy(false);
      await refreshLastStats();
    }
  };

  const onLogout = async () => {
    if (!window.confirm('Log out and clear this session?')) return;
    setBusy(true);
    setBanner(null);
    try {
      await postLogout();
      showSuccess('Logged out. Re-scan QR when ready.');
      await refreshAuth();
      await refreshQr();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const connected = !!auth?.connected;
  const sendLocked = !!lastStats?.sendInProgress;

  return (
    <div className="app">
      <header>
        <div>
          <h1>WhatsApp Bulk Console</h1>
          <p className="sub">Local API dashboard · pairs with the Express backend</p>
        </div>
        <div className="pills">
          <Pill tone={health ? 'ok' : 'bad'}>
            <span className="dot" aria-hidden />
            API {health ? 'up' : 'down'}
          </Pill>
          {health?.testMode ? (
            <Pill tone="warn">
              <span className="dot" aria-hidden />
              TEST_MODE
            </Pill>
          ) : null}
          <Pill tone={connected ? 'ok' : 'warn'}>
            <span className="dot" aria-hidden />
            {connected ? 'WhatsApp connected' : `State: ${auth?.state || '…'}`}
          </Pill>
        </div>
      </header>

      {banner ? (
        <div className={`banner ${banner.type === 'error' ? 'error' : 'success'}`}>
          {banner.text}
        </div>
      ) : null}

      <div className="grid grid-2">
        <div className="card">
          <h2>Session &amp; QR</h2>
          <p className="hint">
            Open WhatsApp on your phone → Linked devices → Link a device, then scan the code
            below.
          </p>
          {auth?.user?.pushname ? (
            <p className="mono" style={{ marginTop: 0 }}>
              Signed in as <strong>{auth.user.pushname}</strong>
            </p>
          ) : null}
          {auth?.lastError ? (
            <p className="hint" style={{ color: 'var(--danger)' }}>
              {auth.lastError}
            </p>
          ) : null}
          <div className="qr-wrap">
            {!connected && qrSrc ? (
              <img src={qrSrc} alt="WhatsApp QR code" width={256} height={256} />
            ) : null}
            {!connected && !qrSrc && qrPayload?.message ? (
              <p className="hint" style={{ textAlign: 'center' }}>
                {qrPayload.message}
              </p>
            ) : null}
            {connected ? (
              <p className="hint" style={{ textAlign: 'center' }}>
                You are connected. No QR is shown.
              </p>
            ) : null}
          </div>
          <div className="row">
            <button type="button" className="btn-ghost" onClick={() => refreshQr()} disabled={busy}>
              Refresh QR
            </button>
            <button type="button" className="btn-danger" onClick={onLogout} disabled={busy}>
              Log out
            </button>
          </div>
        </div>

        <div className="card">
          <h2>Message &amp; CSV</h2>
          <p className="hint">
            Upload a CSV with a <span className="mono">phone</span> column (or first column =
            number). Max batch size is enforced on the server.{' '}
            <strong>One WhatsApp message is sent per unique number</strong> — if preview shows
            “1 unique number”, only one message will go out (check for duplicate rows or
            semicolon-separated CSV from Excel).
          </p>
          <label htmlFor="msg">Message</label>
          <textarea
            id="msg"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Hi {{name}} — your message here"
            disabled={busy}
          />
          <label htmlFor="csv" style={{ marginTop: '0.85rem' }}>
            CSV file
          </label>
          <input
            id="csv"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setPreview(null);
            }}
            disabled={busy}
          />
          <div className="row">
            <button type="button" className="btn-ghost" onClick={onPreview} disabled={busy}>
              Preview numbers
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onSend}
              disabled={busy || sendLocked}
              title={sendLocked ? 'Send already running' : ''}
            >
              {sendLocked ? 'Send running…' : 'Send bulk'}
            </button>
          </div>
          {preview?.numbers?.length ? (
            <div style={{ marginTop: '1rem' }}>
              <label>Preview ({preview.count} unique)</label>
              {preview.parseMeta ? (
                <p className="hint" style={{ marginBottom: '0.5rem' }}>
                  {preview.parseMeta.csvRowsRead} row(s) read from CSV
                  {preview.parseMeta.duplicateNumbersInFile
                    ? ` · ${preview.parseMeta.duplicateNumbersInFile} duplicate number(s) in file (not sent twice)`
                    : ''}
                  {preview.parseMeta.separator
                    ? ` · delimiter: ${preview.parseMeta.separator === '\t' ? 'tab' : `"${preview.parseMeta.separator}"`}`
                    : ''}
                </p>
              ) : null}
              <ul className="preview-list mono">
                {preview.numbers.slice(0, 80).map((n) => (
                  <li key={n}>{n}</li>
                ))}
                {preview.numbers.length > 80 ? (
                  <li style={{ color: 'var(--muted)' }}>… and more</li>
                ) : null}
              </ul>
              {preview.wouldTruncate ? (
                <p className="hint" style={{ marginTop: '0.5rem', color: 'var(--warning)' }}>
                  Server will only send first {preview.maxMessagesPerBatch} numbers.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="card" style={{ marginTop: '1.25rem' }}>
        <h2>Last job</h2>
        <p className="hint">Updates every few seconds. During sends, progress appears here.</p>
        {lastStats?.lastSend ? (
          <div className="stats">
            <div className="stat">
              <strong>{lastStats.lastSend.sent ?? 0}</strong>
              <span>Sent</span>
            </div>
            <div className="stat">
              <strong>{lastStats.lastSend.failed ?? 0}</strong>
              <span>Failed</span>
            </div>
            <div className="stat">
              <strong>{lastStats.lastSend.total ?? 0}</strong>
              <span>Total</span>
            </div>
            <div className="stat">
              <strong>{lastStats.lastSend.truncated ?? 0}</strong>
              <span>Truncated</span>
            </div>
            <div className="stat">
              <strong>{lastStats.sendInProgress ? 'Yes' : 'No'}</strong>
              <span>In progress</span>
            </div>
          </div>
        ) : (
          <p className="hint">No job recorded yet.</p>
        )}
      </div>
    </div>
  );
}
