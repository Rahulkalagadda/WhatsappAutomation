const config = require('./config');
const { createApp } = require('./app');

const app = createApp();

app.listen(config.port, () => {
  console.log('[Boot] WhatsApp bulk backend listening on port', config.port);
  console.log('[Boot] TEST_MODE =', config.testMode);
  console.log('[Boot] MAX_MESSAGES_PER_BATCH =', config.maxMessagesPerBatch);
});
