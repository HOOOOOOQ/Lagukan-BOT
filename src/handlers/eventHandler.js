'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger').child('EventHandler');

function loadEvents(client, eventsDir = path.join(__dirname, '..', 'events')) {
  if (!fs.existsSync(eventsDir)) {
    logger.warn(`Direktori events tidak ditemukan: ${eventsDir}`);
    return 0;
  }

  const files = fs
    .readdirSync(eventsDir)
    .filter((file) => file.endsWith('.js'));

  let count = 0;

  for (const file of files) {
    const filePath = path.join(eventsDir, file);
    const eventModule = require(filePath);

    // Modul khusus playerEvents mendaftarkan banyak listener pada instance Shoukaku
    if (typeof eventModule.register === 'function') {
      eventModule.register(client);
      count += 1;
      continue;
    }

    if (!eventModule?.name || typeof eventModule.execute !== 'function') {
      logger.warn(`Melewati file event tidak valid: ${filePath}`);
      continue;
    }

    if (eventModule.once) {
      client.once(eventModule.name, (...args) => eventModule.execute(...args, client));
    } else {
      client.on(eventModule.name, (...args) => eventModule.execute(...args, client));
    }

    count += 1;
  }

  logger.info(`Berhasil memasang ${count} modul event.`);
  return count;
}

module.exports = {
  loadEvents
};
