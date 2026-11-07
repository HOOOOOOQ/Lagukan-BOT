'use strict';

const { Events } = require('discord.js');
const { config } = require('../../config/config');
const { handlePlayerButton } = require('../buttons/playerButtons');
const { validateMusicChannel } = require('../utils/permissions');
const { globalRateLimiter } = require('../utils/rateLimiter');
const {
  AppError,
  ErrorCodes,
  handleInteractionError
} = require('../utils/errorHandler');
const logger = require('../utils/logger').child('Interaction');

const MUSIC_CATEGORIES = new Set(['playback', 'queue', 'voice', 'utility']);

module.exports = {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction, client) {
    try {
      // 1. Autocomplete
      if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (command && typeof command.autocomplete === 'function') {
          await command.autocomplete(interaction, client).catch(() => {});
        }
        return;
      }

      // 2. Tombol Global Music Player & Navigasi Halaman Queue
      if (interaction.isButton()) {
        const customId = interaction.customId || '';
        if (!customId.startsWith('music:') && !customId.startsWith('queue_nav:')) {
          // Ditangani oleh collector lokal pada command (seperti /search, /help, /lyrics)
          return;
        }

        const rl = globalRateLimiter.check(
          `btn:${interaction.user.id}`,
          config.rateLimit.buttonCooldownMs
        );
        if (rl.limited) {
          throw new AppError(
            ErrorCodes.RATE_LIMITED,
            `Mohon tunggu **${(rl.retryAfterMs / 1000).toFixed(1)} detik** sebelum menekan tombol lagi.`,
            { isWarning: true }
          );
        }

        await handlePlayerButton(interaction, client);
        return;
      }

      // 3. Slash Commands
      if (!interaction.isChatInputCommand()) {
        return;
      }

      const command = client.commands.get(interaction.commandName);
      if (!command) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Perintah \`/${interaction.commandName}\` tidak ditemukan pada sistem LaguKan.`,
          { isWarning: true }
        );
      }

      if (!command.allowDM && !interaction.inGuild()) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'Perintah ini hanya dapat dijalankan di dalam server Discord.',
          { isWarning: true }
        );
      }

      const rl = globalRateLimiter.check(
        `cmd:${interaction.user.id}:${command.data.name}`,
        command.cooldownMs ?? config.rateLimit.commandCooldownMs
      );
      if (rl.limited) {
        throw new AppError(
          ErrorCodes.RATE_LIMITED,
          `Anda mengirim perintah terlalu cepat. Coba lagi dalam **${(rl.retryAfterMs / 1000).toFixed(1)} detik**.`,
          { isWarning: true }
        );
      }

      if (
        interaction.inGuild() &&
        MUSIC_CATEGORIES.has(command.category) &&
        command.data.name !== 'dj'
      ) {
        const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
        validateMusicChannel(interaction, guildSettings);
      }

      logger.debug(
        `Menjalankan /${command.data.name} oleh ${interaction.user.tag} di guild ${interaction.guildId || 'DM'}`
      );
      await command.execute(interaction, client);
    } catch (err) {
      const label = interaction.commandName
        ? `/${interaction.commandName}`
        : interaction.customId || 'Interaction';
      await handleInteractionError(interaction, err, label);
    }
  }
};
