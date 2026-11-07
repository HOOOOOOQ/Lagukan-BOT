'use strict';

const { Events, ActivityType } = require('discord.js');
const { config } = require('../../config/config');
const { deploySlashCommands } = require('../handlers/deployCommands');
const logger = require('../utils/logger').child('ReadyEvent');

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(readyClient, client) {
    logger.info(
      `✅ ${config.bot.name} v${config.bot.version} berhasil login sebagai ${readyClient.user.tag}!`
    );
    logger.info(
      `Developer: ${config.bot.developer} | Server terhubung: ${readyClient.guilds.cache.size} | Slash Commands: ${client.commands.size}`
    );

    const updatePresence = () => {
      try {
        readyClient.user.setPresence({
          activities: [
            {
              name: `/play • ${config.bot.name} | ${config.bot.developer}`,
              type: ActivityType.Listening
            }
          ],
          status: 'online'
        });
      } catch {
        // Abaikan jika WebSocket sedang reconnecting
      }
    };

    updatePresence();
    client.presenceInterval = setInterval(updatePresence, 15 * 60 * 1000);
    if (typeof client.presenceInterval.unref === 'function') {
      client.presenceInterval.unref();
    }

    if (config.bot.autoDeployCommands) {
      try {
        const payloads = [...client.commands.values()].map((c) => c.data.toJSON());
        await deploySlashCommands({ payloads });
      } catch (err) {
        logger.error('Auto-deploy Slash Commands saat startup mengalami kendala', err);
      }
    }
  }
};
