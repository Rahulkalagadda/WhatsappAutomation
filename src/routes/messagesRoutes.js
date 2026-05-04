const express = require('express');
const { csvUpload } = require('../middleware/upload');
const messagesController = require('../controllers/messagesController');

const router = express.Router();

router.post(
  '/messages/preview',
  csvUpload.single('file'),
  messagesController.preview,
);

router.post(
  '/messages/send',
  csvUpload.single('file'),
  messagesController.send,
);

router.get('/messages/last-stats', messagesController.lastStats);
router.post('/messages/cancel', messagesController.cancel);
router.post('/messages/reset', messagesController.reset);

module.exports = router;
