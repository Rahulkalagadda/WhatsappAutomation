/**
 * Normalize a raw phone string for whatsapp-web.js chat IDs.
 * Strips non-digits, drops leading +, ensures @c.us suffix.
 *
 * @param {string} raw
 * @returns {string|null} e.g. "919876543210@c.us" or null if invalid
 */
function normalizeToChatId(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Keep digits only (removes spaces, dashes, parentheses, +, etc.)
  const digits = s.replace(/\D/g, '');
  if (!digits || digits.length < 8) return null;

  return `${digits}@c.us`;
}

module.exports = {
  normalizeToChatId,
};
