'use strict';

require('dotenv').config({ quiet: true });

const { config } = require('./config/config');
const { LaguKanClient } = require('./src/client');
const logger = require('./src/utils/logger');

const client = new LaguKanClient();
let shuttingDown = false;

async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await client.shutdown(signal);
  process.exit(0);
}

process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection tertangkap (proses tetap berjalan)', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception tertangkap', err);
});

async function bootstrap() {
  const isTermux = Boolean(process.env.TERMUX_VERSION || process.platform === 'android');
  logger.info(
    `==========================================================`
  );
  logger.info(
    `🎵 ${config.bot.name} v${config.bot.version} — Discord Music Bot`
  );
  logger.info(
    `👨‍💻 Developer: ${config.bot.developer} | Runtime: Node.js ${process.version}${isTermux ? ' (Android Termux)' : ''}`
  );
  logger.info(
    `==========================================================`
  );

  try {
    await client.start();
  } catch (err) {
    logger.error('Gagal menjalankan LaguKan saat startup', err);
    client.db.close();
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}

module.exports = {
  client,
  bootstrap
};
