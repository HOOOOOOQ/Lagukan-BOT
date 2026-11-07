'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { parseTimeInput, formatDuration, truncate } = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Lompat ke posisi waktu tertentu pada lagu yang sedang diputar')
    .addStringOption((opt) =>
      opt
        .setName('waktu')
        .setDescription('Posisi waktu tujuan, contoh: 90, 1:30, 02:15, atau 2m30s')
        .setRequired(true)
        .setMaxLength(20)
    ),

  async execute(interaction, client) {
    const rawTime = interaction.options.getString('waktu', true);
    const positionMs = parseTimeInput(rawTime);

    if (positionMs === null) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Format waktu tidak valid! Gunakan detik (`90`), format titik dua (`1:30` / `01:02:30`), atau satuan (`2m15s`).',
        { isWarning: true }
      );
    }

    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'track');

    await musicPlayer.seek(positionMs);

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Posisi Lagu Diubah',
          `⏩ Melompat ke menit **\`${formatDuration(positionMs)}\`** pada lagu **${truncate(musicPlayer.currentTrack?.info?.title || 'saat ini', 100)}**.`
        )
      ]
    });
  }
};
