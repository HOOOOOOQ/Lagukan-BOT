'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { config, validateConfig } = require('../../config/config');
const logger = require('../utils/logger').child('DeployCommands');

function collectCommandPayloads(commandsDir = path.join(__dirname, '..', 'commands')) {
  const payloads = [];
  if (!fs.existsSync(commandsDir)) return payloads;

  const categories = fs
    .readdirSync(commandsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const cat of categories) {
    const dir = path.join(commandsDir, cat);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const file of files) {
      const cmd = require(path.join(dir, file));
      if (cmd?.data && typeof cmd.data.toJSON === 'function') {
        payloads.push(cmd.data.toJSON());
      }
    }
  }

  return payloads;
}

async function deploySlashCommands(options = {}) {
  const check = validateConfig();
  if (!check.valid) {
    throw new Error(
      `Konfigurasi belum lengkap: ${check.missing.join(', ')}. Periksa file .env Anda.`
    );
  }

  const payloads = options.payloads || collectCommandPayloads();
  const clearMode = Boolean(options.clear);
  const body = clearMode ? [] : payloads;

  const rest = new REST({ version: '10' }).setToken(config.bot.token);
  const targetGuildId = options.forceGlobal ? '' : (options.guildId ?? config.bot.guildId);

  if (targetGuildId) {
    logger.info(
      `${clearMode ? 'Menghapus' : `Mendaftarkan ${body.length}`} Slash Command ke Guild ID: ${targetGuildId}...`
    );
    const result = await rest.put(
      Routes.applicationGuildCommands(config.bot.clientId, targetGuildId),
      { body }
    );
    logger.info(`Sinkronisasi Slash Command Guild berhasil (${Array.isArray(result) ? result.length : 0} command).`);
    return result;
  }

  logger.info(
    `${clearMode ? 'Menghapus' : `Mendaftarkan ${body.length}`} Slash Command secara Global...`
  );
  const result = await rest.put(
    Routes.applicationCommands(config.bot.clientId),
    { body }
  );
  logger.info(`Sinkronisasi Slash Command Global berhasil (${Array.isArray(result) ? result.length : 0} command).`);
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const forceGlobal = args.includes('--global');
  const clear = args.includes('--clear');

  deploySlashCommands({ forceGlobal, clear })
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Gagal mendaftarkan Slash Command ke Discord API', err);
      process.exit(1);
    });
}

module.exports = {
  collectCommandPayloads,
  deploySlashCommands
};
