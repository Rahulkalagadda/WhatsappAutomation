const multer = require('multer');

const memory = multer.memoryStorage();

/**
 * Accept a single CSV file + text fields for message routes.
 */
const csvUpload = multer({
  storage: memory,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const looksCsv = name.endsWith('.csv');
    const mimeOk =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/plain' ||
      (file.mimetype === 'application/octet-stream' && looksCsv);
    if (!looksCsv && !mimeOk) {
      cb(new Error('Only .csv files are allowed'));
      return;
    }
    cb(null, true);
  },
});

module.exports = {
  csvUpload,
};
