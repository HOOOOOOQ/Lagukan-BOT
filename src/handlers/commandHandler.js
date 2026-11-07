'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger').child('CommandHandler');

function loadCommands(client, commandsDir = path.join(__dirname, '..', 'commands')) {
  client.commands.clear();

  if (!fs.existsSync(commandsDir)) {
    logger.warn(`Direktori commands tidak ditemukan: ${commandsDir}`);
    return [];
  }

  const categories = fs
    .readdirSync(commandsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const loaded = [];

  for (const category of categories) {
    const categoryPath = path.join(commandsDir, category);
    const files = fs
      .readdirSync(categoryPath)
      .filter((file) => file.endsWith('.js'));

    for (const file of files) {
      const filePath = path.join(categoryPath, file);
      const command = require(filePath);

      if (!command?.data?.name || typeof command.execute !== 'function') {
        logger.warn(`Melewati file command tidak valid: ${filePath}`);
        continue;
      }

      command.category = command.category || category;
      client.commands.set(command.data.name, command);
      loaded.push(command);
    }
  }

  logger.info(`Berhasil memuat ${loaded.length} Slash Command dari ${categories.length} kategori.`);
  return loaded;
}

module.exports = {
  loadCommands
};
