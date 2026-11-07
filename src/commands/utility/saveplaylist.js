'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('saveplaylist')
    .setDescription('Simpan lagu yang sedang diputar beserta seluruh antrean ke dalam playlist SQLite')
    .addStringOption((opt) =>
      opt
        .setName('nama')
        .setDescription('Nama playlist yang ingin disimpan (2 - 50 karakter)')
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(50)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('publik')
        .setDescription('Izinkan anggota lain di server ini memuat playlist ini (default: false)')
        .setRequired(false)
    ),

  async execute(interaction, client) {
    const name = interaction.options.getString('nama', true).trim();
    const isPublic = interaction.options.getBoolean('publik') || false;

    const musicPlayer = client.playerManager.get(interaction.guildId);
    if (!musicPlayer) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        'Tidak ada lagu maupun antrean aktif untuk disimpan. Putar lagu dengan `/play` terlebih dahulu.',
        { isWarning: true }
      );
    }

    const allTracks = musicPlayer.queue.getAllTracksIncludingCurrent(musicPlayer.currentTrack);
    if (allTracks.length === 0) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        'Antrean kosong — tidak ada lagu untuk disimpan.',
        { isWarning: true }
      );
    }

    const saved = client.playlistsRepo.savePlaylist({
      name,
      ownerId: interaction.user.id,
      ownerTag: interaction.user.tag,
      guildId: interaction.guildId,
      isPublic,
      tracks: allTracks
    });

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          saved.overwritten ? 'Playlist Diperbarui' : 'Playlist Tersimpan',
          `💾 Playlist **${saved.name}** berhasil disimpan ke database dengan **${saved.trackCount} lagu**!\n` +
          `🔒 Visibilitas: **${saved.isPublic ? 'Publik di Server Ini' : 'Pribadi'}**\n\n` +
          `Gunakan \`/loadplaylist nama:${saved.name}\` kapan saja untuk memutarnya kembali.`
        )
      ]
    });
  }
};
