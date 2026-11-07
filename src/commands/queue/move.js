'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Pindahkan urutan lagu dari satu posisi ke posisi lain di antrean')
    .addIntegerOption((opt) =>
      opt
        .setName('dari')
        .setDescription('Nomor posisi asal lagu di antrean')
        .setRequired(true)
        .setMinValue(1)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('ke')
        .setDescription('Nomor posisi tujuan baru di antrean')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction, client) {
    const fromPos = interaction.options.getInteger('dari', true);
    const toPos = interaction.options.getInteger('ke', true);

    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    if (musicPlayer.queue.size < 2) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Minimal dibutuhkan **2 lagu** dalam antrean untuk memindahkan posisi.',
        { isWarning: true }
      );
    }

    const moved = musicPlayer.queue.move(fromPos, toPos);
    await musicPlayer.updatePlayerMessage();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Posisi Lagu Dipindahkan',
          `↕️ Lagu **${truncate(moved.info?.title || 'lagu', 120)}** dipindahkan dari posisi **#${fromPos}** ke **#${toPos}**.`
        )
      ]
    });
  }
};
