const express = require('express');
const { getQr, getStatus, logout } = require('../controllers/authController');

const router = express.Router();

router.get('/auth/qr', getQr);
router.get('/auth/status', getStatus);
router.post('/auth/logout', logout);

module.exports = router;
