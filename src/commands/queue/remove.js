'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Hapus lagu pada nomor posisi tertentu dari antrean')
    .addIntegerOption((opt) =>
      opt
        .setName('posisi')
        .setDescription('Nomor posisi lagu di antrean (lihat melalui /queue)')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction, client) {
    const position = interaction.options.getInteger('posisi', true);
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    if (musicPlayer.queue.isEmpty) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Antrean saat ini sedang kosong.', {
        isWarning: true
      });
    }

    const target = musicPlayer.queue.getAt(position);
    if (!target) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Posisi **#${position}** tidak ditemukan. Antrean memiliki **${musicPlayer.queue.size}** lagu.`,
        { isWarning: true }
      );
    }

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(
      interaction,
      musicPlayer,
      guildSettings,
      'queue_manage',
      target.requester?.id || null
    );

    const removed = musicPlayer.queue.remove(position);
    await musicPlayer.updatePlayerMessage();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Lagu Dihapus dari Antrean',
          `🗑️ Menghapus **${truncate(removed.info?.title || 'lagu', 120)}** dari posisi **#${position}**.`
        )
      ]
    });
  }
};
