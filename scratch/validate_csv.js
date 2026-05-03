
const fs = require('fs');
const content = fs.readFileSync('whatsapp_bulk_contacts_full.csv', 'utf8');
const lines = content.split('\n');
const headers = lines[0].split(',');
console.log('Headers:', headers);

const seenNumbers = new Map();
const issues = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const cells = line.split(',');
  if (cells.length !== 2) {
    issues.push(`Line ${i+1}: Wrong column count (${cells.length})`);
    continue;
  }
  const name = cells[0];
  const number = cells[1];
  const digits = number.replace(/\D/g, '');
  
  if (digits.length !== 12 && digits.length > 0) {
    issues.push(`Line ${i+1}: Unusual digit length (${digits.length}) - ${number}`);
  }
  
  if (seenNumbers.has(digits)) {
    issues.push(`Line ${i+1}: Duplicate number (${digits}) - originally at Line ${seenNumbers.get(digits)}`);
  } else {
    seenNumbers.set(digits, i + 1);
  }
}

if (issues.length === 0) {
  console.log('No issues found in data rows.');
} else {
  console.log('Issues found:');
  issues.forEach(iss => console.log(' - ' + iss));
}
