const { Readable } = require('stream');
const csv = require('csv-parser');
const { normalizeToChatId } = require('./phoneNormalizer');

/**
 * @param {string} s
 */
function stripBom(s) {
  return s.replace(/^\uFEFF/, '');
}

/**
 * Guess delimiter from the first non-empty line (Excel EU often exports `;`).
 * @param {Buffer} buffer
 * @returns {','|';'|'\t'}
 */
function detectSeparator(buffer) {
  const sample = stripBom(buffer.toString('utf8', 0, Math.min(buffer.length, 16_384)));
  const firstLine = sample.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * Extract phone-like value from a CSV row.
 * Supports common column names; otherwise uses first non-empty cell.
 *
 * @param {Record<string, string>} row
 * @returns {string|null}
 */
function pickPhoneFromRow(row) {
  const entries = Object.entries(row).map(([k, v]) => [
    stripBom(String(k)).trim().toLowerCase(),
    v,
  ]);
  const preferred = ['phone', 'mobile', 'number', 'whatsapp', 'tel', 'msisdn', 'cell', 'contact'];

  for (const p of preferred) {
    const hit = entries.find(([k]) => k === p);
    if (hit && hit[1] !== undefined && String(hit[1]).trim() !== '') {
      return String(hit[1]);
    }
  }

  for (const [, v] of entries) {
    if (v !== undefined && String(v).trim() !== '') {
      return String(v);
    }
  }
  return null;
}

/**
 * Extract the recipient display name from common CSV columns.
 * @param {Record<string, string>} row
 * @returns {string}
 */
function pickNameFromRow(row) {
  const entries = Object.entries(row).map(([k, v]) => [
    stripBom(String(k)).trim().toLowerCase(),
    v,
  ]);
  const preferred = ['name', 'full_name', 'fullname', 'first_name', 'firstname'];

  for (const p of preferred) {
    const hit = entries.find(([k]) => k === p);
    if (hit && hit[1] !== undefined && String(hit[1]).trim() !== '') {
      return String(hit[1]).trim();
    }
  }

  return '';
}

/**
 * Parse CSV buffer into unique normalized chat IDs (order preserved).
 * Handles UTF-8 BOM, `;` or `,` delimiters, and trims headers so all rows are read.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{
 *   numbers: string[],
 *   recipients: { chatId: string, variables: Record<string, string> }[],
 *   skipped: { raw: string, reason: string }[],
 *   parseMeta: {
 *     separator: string,
 *     csvRowsRead: number,
 *     duplicateNumbersInFile: number,
 *   }
 * }>}
 */
function parsePhoneNumbersFromCsv(buffer) {
  return new Promise((resolve, reject) => {
    const numbers = [];
    const recipients = [];
    const seen = new Set();
    const skipped = [];
    const separator = detectSeparator(buffer);
    let csvRowsRead = 0;
    let duplicateNumbersInFile = 0;

    const stream = Readable.from(buffer);

    stream
      .pipe(
        csv({
          separator,
          mapHeaders: ({ header }) => stripBom(String(header)).trim(),
        }),
      )
      .on('data', (row) => {
        csvRowsRead += 1;
        const raw = pickPhoneFromRow(row);
        if (!raw) {
          skipped.push({ raw: JSON.stringify(row), reason: 'empty_row' });
          return;
        }
        const id = normalizeToChatId(raw);
        if (!id) {
          skipped.push({ raw, reason: 'invalid_phone' });
          return;
        }
        if (seen.has(id)) {
          duplicateNumbersInFile += 1;
          return;
        }
        seen.add(id);
        numbers.push(id);
        recipients.push({
          chatId: id,
          variables: {
            name: pickNameFromRow(row),
          },
        });
      })
      .on('end', () =>
        resolve({
          numbers,
          recipients,
          skipped,
          parseMeta: {
            separator,
            csvRowsRead,
            duplicateNumbersInFile,
            uniqueCount: numbers.length,
          },
        }),
      )
      .on('error', (err) => reject(err));
  });
}

module.exports = {
  parsePhoneNumbersFromCsv,
  pickPhoneFromRow,
  pickNameFromRow,
  detectSeparator,
};
