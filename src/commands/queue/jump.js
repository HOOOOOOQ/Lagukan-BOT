'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('jump')
    .setDescription('Lompat langsung memutar lagu pada posisi tertentu di antrean')
    .addIntegerOption((opt) =>
      opt
        .setName('posisi')
        .setDescription('Nomor posisi lagu di antrean yang ingin langsung diputar')
        .setRequired(true)
        .setMinValue(1)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('simpan_yang_dilewati')
        .setDescription('Tetap biarkan lagu sebelum posisi tersebut berada di antrean (default: false)')
        .setRequired(false)
    ),

  async execute(interaction, client) {
    const position = interaction.options.getInteger('posisi', true);
    const keepSkipped = interaction.options.getBoolean('simpan_yang_dilewati') || false;

    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    if (musicPlayer.queue.isEmpty) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Antrean saat ini sedang kosong.', {
        isWarning: true
      });
    }

    await interaction.deferReply();

    if (musicPlayer.currentTrack) {
      musicPlayer.queue.pushHistory(musicPlayer.currentTrack);
    }

    const target = musicPlayer.queue.jump(position, !keepSkipped);
    await musicPlayer.playSpecificTrack(target);

    return interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          'Melompat ke Lagu Pilihan',
          `⏭️ Melompat ke posisi **#${position}** dan memutar **${truncate(target.info?.title || 'lagu', 120)}**.`
        )
      ]
    });
  }
};
