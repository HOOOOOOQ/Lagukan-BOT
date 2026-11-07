'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { buildQueuePayload } = require('../../utils/embeds');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Tampilkan daftar antrean lagu yang akan diputar pada server ini')
    .addIntegerOption((opt) =>
      opt
        .setName('halaman')
        .setDescription('Nomor halaman antrean yang ingin ditampilkan')
        .setRequired(false)
        .setMinValue(1)
    ),

  async execute(interaction, client) {
    const page = interaction.options.getInteger('halaman') || 1;
    const musicPlayer = client.playerManager.get(interaction.guildId);

    if (!musicPlayer || (!musicPlayer.currentTrack && musicPlayer.queue.isEmpty)) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        'Antrean musik sedang kosong. Gunakan `/play` untuk menambahkan lagu!',
        { isWarning: true }
      );
    }

    const payload = buildQueuePayload(musicPlayer, page);
    return interaction.reply(payload);
  }
};
