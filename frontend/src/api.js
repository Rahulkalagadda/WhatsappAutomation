/** Same-origin in production (Express serves dist); Vite proxies in dev. */
const json = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
};

export async function fetchHealth() {
  const res = await fetch('/health');
  return json(res);
}

export async function fetchAuthStatus() {
  const res = await fetch('/auth/status');
  return json(res);
}

export async function fetchAuthQr() {
  const res = await fetch('/auth/qr');
  return json(res);
}

export async function postLogout() {
  const res = await fetch('/auth/logout', { method: 'POST' });
  return json(res);
}

export async function postPreview(formData) {
  const res = await fetch('/messages/preview', {
    method: 'POST',
    body: formData,
  });
  return json(res);
}

export async function postSend(formData) {
  const res = await fetch('/messages/send', {
    method: 'POST',
    body: formData,
  });
  return json(res);
}

export async function fetchLastStats() {
  const res = await fetch('/messages/last-stats');
  return json(res);
}
