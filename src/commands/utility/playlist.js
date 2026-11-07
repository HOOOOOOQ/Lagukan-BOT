'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { config } = require('../../../config/config');
const {
  createBaseEmbed,
  buildSuccessEmbed,
  buildInfoEmbed
} = require('../../utils/embeds');
const {
  formatDuration,
  truncate,
  escapeMarkdownLinkText
} = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Kelola daftar playlist tersimpan milik Anda di database LaguKan')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Lihat semua playlist milik Anda dan playlist publik di server ini')
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('Lihat daftar lagu di dalam suatu playlist')
        .addStringOption((opt) =>
          opt
            .setName('nama')
            .setDescription('Nama playlist')
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(50)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('addtrack')
        .setDescription('Tambahkan 1 lagu (atau lagu yang sedang diputar) ke dalam playlist')
        .addStringOption((opt) =>
          opt
            .setName('nama')
            .setDescription('Nama playlist tujuan (otomatis dibuat jika belum ada)')
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(50)
        )
        .addStringOption((opt) =>
          opt
            .setName('lagu')
            .setDescription('Judul/URL lagu (kosongkan untuk menyimpan lagu yang sedang diputar)')
            .setRequired(false)
            .setMaxLength(400)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('removetrack')
        .setDescription('Hapus satu lagu berdasarkan nomor urut dari playlist milik Anda')
        .addStringOption((opt) =>
          opt
            .setName('nama')
            .setDescription('Nama playlist milik Anda')
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(50)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('nomor')
            .setDescription('Nomor urut lagu pada playlist')
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Hapus playlist milik Anda secara permanen dari database')
        .addStringOption((opt) =>
          opt
            .setName('nama')
            .setDescription('Nama playlist milik Anda yang ingin dihapus')
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(50)
        )
    ),

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase();
    const lists = client.playlistsRepo.listAccessiblePlaylists(
      interaction.user.id,
      interaction.guildId
    );
    const filtered = lists
      .filter((p) => p.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((p) => ({
        name: truncate(`${p.name} (${p.track_count} lagu)`, 100),
        value: p.name
      }));
    await interaction.respond(filtered);
  },

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const lists = client.playlistsRepo.listAccessiblePlaylists(
        interaction.user.id,
        interaction.guildId
      );

      if (lists.length === 0) {
        return interaction.reply({
          embeds: [
            buildInfoEmbed(
              'Belum Ada Playlist Tersimpan',
              'Anda belum memiliki playlist tersimpan.\nGunakan `/saveplaylist` saat memutar musik atau `/playlist addtrack` untuk membuat playlist baru!'
            )
          ]
        });
      }

      const lines = lists.slice(0, 20).map((p, idx) => {
        const badge =
          p.owner_id === interaction.user.id
            ? p.is_public
              ? '🌐 Milik Anda (Publik)'
              : '🔒 Milik Anda'
            : `🌐 Publik oleh ${truncate(p.owner_tag, 25)}`;
        return `\`${String(idx + 1).padStart(2, '0')}.\` **${p.name}** — \`${p.track_count} lagu\` • \`${formatDuration(p.total_duration)}\` • *${badge}*`;
      });

      const embed = createBaseEmbed(config.colors.queue)
        .setTitle('📚 Daftar Playlist Tersimpan')
        .setDescription(lines.join('\n'));

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'view') {
      const name = interaction.options.getString('nama', true).trim();
      const playlist = client.playlistsRepo.findAccessiblePlaylist(
        interaction.user.id,
        interaction.guildId,
        name
      );
      if (!playlist) {
        throw new AppError(
          ErrorCodes.TRACK_NOT_FOUND,
          `Playlist **${name}** tidak ditemukan.`
        );
      }

      const tracks = client.playlistsRepo.getTracks(playlist.id);
      const totalDur = tracks.reduce((sum, t) => sum + Number(t.duration || 0), 0);

      const preview = tracks.slice(0, 20).map((t) => {
        const title = escapeMarkdownLinkText(truncate(t.title, 60));
        const link = t.uri ? `[${title}](${t.uri})` : `**${title}**`;
        return `\`${String(t.position).padStart(2, '0')}.\` ${link} — *${truncate(t.author, 30)}* \`[${formatDuration(t.duration)}]\``;
      });

      if (tracks.length > 20) {
        preview.push(`\n*...dan ${tracks.length - 20} lagu lainnya.*`);
      }

      const embed = createBaseEmbed(config.colors.queue)
        .setTitle(`💿 Playlist: ${playlist.name}`)
        .setDescription(preview.length ? preview.join('\n') : '*Playlist kosong.*')
        .addFields(
          { name: '🎵 Total Lagu', value: `\`${tracks.length}\``, inline: true },
          { name: '⏱️ Total Durasi', value: `\`${formatDuration(totalDur)}\``, inline: true },
          { name: '👤 Pembuat', value: truncate(playlist.owner_tag, 50), inline: true }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'addtrack') {
      const name = interaction.options.getString('nama', true).trim();
      const songQuery = interaction.options.getString('lagu')?.trim();
      let trackToAdd = null;

      if (!songQuery) {
        const mp = client.playerManager.get(interaction.guildId);
        if (!mp?.currentTrack) {
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            'Tidak ada lagu yang sedang diputar. Isi opsi `lagu` dengan judul atau URL musik.',
            { isWarning: true }
          );
        }
        trackToAdd = mp.currentTrack;
      } else {
        const node = client.playerManager.requireAvailableNode();
        await interaction.deferReply();
        const resolved = await client.sourceResolver.resolve(node, songQuery, interaction.user);
        trackToAdd = resolved.tracks[0];
      }

      const added = client.playlistsRepo.addTrack(
        interaction.user.id,
        name,
        trackToAdd,
        interaction.user.tag,
        interaction.guildId
      );

      const replyEmbed = buildSuccessEmbed(
        'Lagu Ditambahkan ke Playlist',
        `➕ Menambahkan **${truncate(trackToAdd.info.title, 120)}** ke playlist **${added.playlist.name}** (urutan \`#${added.position}\`).`
      );

      if (interaction.deferred) {
        return interaction.editReply({ embeds: [replyEmbed] });
      }
      return interaction.reply({ embeds: [replyEmbed] });
    }

    if (sub === 'removetrack') {
      const name = interaction.options.getString('nama', true).trim();
      const position = interaction.options.getInteger('nomor', true);

      const { playlist, removedTrack } = client.playlistsRepo.removeTrack(
        interaction.user.id,
        name,
        position
      );

      return interaction.reply({
        embeds: [
          buildSuccessEmbed(
            'Lagu Dihapus dari Playlist',
            `🗑️ Menghapus **${truncate(removedTrack.title, 120)}** dari playlist **${playlist.name}**.`
          )
        ]
      });
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('nama', true).trim();
      const deleted = client.playlistsRepo.deletePlaylist(interaction.user.id, name);

      return interaction.reply({
        embeds: [
          buildSuccessEmbed(
            'Playlist Dihapus',
            `🗑️ Playlist **${deleted.name}** telah dihapus secara permanen dari database.`
          )
        ]
      });
    }
  }
};
