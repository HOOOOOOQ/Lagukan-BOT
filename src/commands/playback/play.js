'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess } = require('../../utils/permissions');
const {
  buildSuccessEmbed,
  buildErrorEmbed,
  buildTrackAddedEmbed,
  buildPlaylistAddedEmbed
} = require('../../utils/embeds');
const { truncate, escapeMarkdownLinkText } = require('../../utils/formatters');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Putar lagu atau playlist dari YouTube, Spotify, SoundCloud, Bandcamp, URL audio, atau judul lagu')
    .addStringOption((opt) =>
      opt
        .setName('lagu')
        .setDescription('Judul lagu, nama artis, atau URL (YouTube / YT Music / Spotify / SoundCloud / Bandcamp / Audio)')
        .setRequired(true)
        .setMaxLength(500)
    ),

  async execute(interaction, client) {
    const query = interaction.options.getString('lagu', true).trim();
    const existingPlayer = client.playerManager.get(interaction.guildId);

    // Tahap 1: Periksa & identifikasi otomatis voice channel tempat pengguna berada
    const { userChannel } = validateVoiceAccess(interaction, existingPlayer, {
      requireBotInVoice: false
    });

    if (client.audioDiagnostics) {
      client.audioDiagnostics.recordStage(
        interaction.guildId,
        1,
        'Command /play Diterima',
        `user="${interaction.user.tag || interaction.user.id}", vc="#${userChannel.name || userChannel.id}"`
      );
    }

    const node = client.playerManager.requireAvailableNode();
    await interaction.deferReply();

    // Tahap 2 & 3: Cari & muat track melalui Lavalink sebelum membuat/mengikat sesi pemutar
    const resolved = await client.sourceResolver.resolve(node, query, interaction.user, {
      guildId: interaction.guildId
    });

    // Tahap 4, 5 & 6: Buat player & otomatis bergabung ke voice channel pengguna
    const musicPlayer = await client.playerManager.getOrCreate({
      guild: interaction.guild,
      voiceChannel: userChannel,
      textChannelId: interaction.channelId
    });

    const wasPlaying = Boolean(musicPlayer.playing && musicPlayer.currentTrack);

    if (resolved.kind === 'playlist') {
      const added = musicPlayer.queue.enqueueMany(resolved.tracks);
      if (!wasPlaying) {
        const startRes = await musicPlayer.playIfIdle({ waitForStart: true });
        if (!startRes?.started && !startRes?.alreadyPlaying && musicPlayer.queue.isEmpty) {
          const reason =
            startRes?.diagnosis?.userMessage ||
            'Seluruh lagu awal pada daftar putar gagal didekode oleh server Lavalink.';
          return interaction.editReply({
            embeds: [buildErrorEmbed('Gagal Memulai Daftar Putar', reason)]
          });
        }
      } else {
        await musicPlayer.updatePlayerMessage();
      }

      const embed = buildPlaylistAddedEmbed(resolved.playlistInfo, added, interaction.user);
      return interaction.editReply({ embeds: [embed] });
    }

    const track = resolved.tracks[0];
    const queuePos = musicPlayer.queue.enqueue(track);

    if (!wasPlaying) {
      // Tahap 7, 8 & 9: Mulai dekode stream, tunggu konfirmasi nyata TrackStartEvent sebelum klaim aktif!
      const startRes = await musicPlayer.playIfIdle({ waitForStart: true });

      if (!startRes?.started) {
        const reason = startRes?.timedOut
          ? 'Server Lavalink tidak mengirimkan konfirmasi mulai putar (`TrackStartEvent`) tepat waktu. Periksa koneksi jaringan dan status `/debugmusic`.'
          : startRes?.diagnosis?.userMessage ||
            `Stream audio untuk **${truncate(track.info.title, 100)}** gagal dimuat atau didekode oleh Lavalink.`;

        return interaction.editReply({
          embeds: [
            buildErrorEmbed(
              'Pemutaran Audio Gagal',
              `Tidak dapat memutar **${truncate(track.info.title, 100)}**.\n\n**Penyebab Teknis:**\n${reason}`
            )
          ]
        });
      }

      const activeTrack = startRes.track || track;
      const title = escapeMarkdownLinkText(truncate(activeTrack.info.title, 120));
      const link = activeTrack.info.uri ? `[${title}](${activeTrack.info.uri})` : `**${title}**`;
      const fallbackNote = startRes.usedDirectDave
        ? `\n🔐 *Stream diputar melalui engine **Direct DAVE E2EE v1** (\`${activeTrack.info.sourceName}\`) agar suara tetap keluar terenkripsi penuh.*`
        : startRes.usedFallback
        ? `\n🔄 *Stream dialihkan otomatis ke **${activeTrack.info.sourceName}** agar audio tetap jernih tanpa kendala dekode.*`
        : '';

      return interaction.editReply({
        embeds: [
          buildSuccessEmbed(
            'Memulai Pemutaran Musik',
            `🎶 Memutar ${link} — *${truncate(activeTrack.info.author, 60)}* di <#${userChannel.id}>.${fallbackNote}\nPanel kontrol musik interaktif telah ditampilkan di channel ini.`
          )
        ]
      });
    }

    // Tambahkan ke antrean jika sedang ada lagu yang diputar
    await musicPlayer.updatePlayerMessage();
    const addedEmbed = buildTrackAddedEmbed(track, queuePos, musicPlayer);
    return interaction.editReply({ embeds: [addedEmbed] });
  }
};
