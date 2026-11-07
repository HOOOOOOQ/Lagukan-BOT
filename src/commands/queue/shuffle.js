'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Acak urutan lagu di dalam antrean saat ini'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    if (musicPlayer.queue.size < 2) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Dibutuhkan minimal **2 lagu** di dalam antrean untuk melakukan pengacakan.',
        { isWarning: true }
      );
    }

    musicPlayer.queue.shuffle();
    await musicPlayer.updatePlayerMessage();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Antrean Diacak',
          `🔀 Sebanyak **${musicPlayer.queue.size} lagu** dalam antrean berhasil diacak!`
        )
      ]
    });
  }
};
