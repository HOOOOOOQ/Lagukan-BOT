'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess } = require('../../utils/permissions');
const {
  buildSuccessEmbed,
  buildTrackAddedEmbed,
  buildPlaylistAddedEmbed
} = require('../../utils/embeds');
const { truncate, escapeMarkdownLinkText } = require('../../utils/formatters');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Putar lagu atau playlist dari YouTube, Spotify, SoundCloud, URL audio, atau judul lagu')
    .addStringOption((opt) =>
      opt
        .setName('lagu')
        .setDescription('Judul lagu, nama artis, atau URL (YouTube / YT Music / Spotify / SoundCloud / Audio)')
        .setRequired(true)
        .setMaxLength(500)
    ),

  async execute(interaction, client) {
    const query = interaction.options.getString('lagu', true).trim();
    const existingPlayer = client.playerManager.get(interaction.guildId);

    // 1 & 2. Periksa & identifikasi otomatis voice channel tempat pengguna berada
    const { userChannel } = validateVoiceAccess(interaction, existingPlayer, {
      requireBotInVoice: false
    });

    const node = client.playerManager.requireAvailableNode();
    await interaction.deferReply();

    // 3. Otomatis bergabung ke voice channel pengguna
    const musicPlayer = await client.playerManager.getOrCreate({
      guild: interaction.guild,
      voiceChannel: userChannel,
      textChannelId: interaction.channelId
    });

    // 4. Proses URL atau pencarian lagu multi-source
    const resolved = await client.sourceResolver.resolve(node, query, interaction.user);
    const wasPlaying = Boolean(musicPlayer.playing && musicPlayer.currentTrack);

    if (resolved.kind === 'playlist') {
      const added = musicPlayer.queue.enqueueMany(resolved.tracks);
      if (!wasPlaying) {
        await musicPlayer.playIfIdle();
      } else {
        await musicPlayer.updatePlayerMessage();
      }

      const embed = buildPlaylistAddedEmbed(resolved.playlistInfo, added, interaction.user);
      return interaction.editReply({ embeds: [embed] });
    }

    const track = resolved.tracks[0];
    const queuePos = musicPlayer.queue.enqueue(track);

    if (!wasPlaying) {
      // 5, 6, 7. Mulai pemutaran otomatis & tampilkan Music Player interaktif di text channel
      await musicPlayer.playIfIdle();
      const title = escapeMarkdownLinkText(truncate(track.info.title, 120));
      const link = track.info.uri ? `[${title}](${track.info.uri})` : `**${title}**`;

      return interaction.editReply({
        embeds: [
          buildSuccessEmbed(
            'Memulai Pemutaran Musik',
            `🎶 Memutar ${link} — *${truncate(track.info.author, 60)}* di <#${userChannel.id}>.\nPanel kontrol musik interaktif telah ditampilkan di channel ini.`
          )
        ]
      });
    }

    // 8. Tambahkan ke antrean jika sedang ada lagu yang diputar
    await musicPlayer.updatePlayerMessage();
    const addedEmbed = buildTrackAddedEmbed(track, queuePos, musicPlayer);
    return interaction.editReply({ embeds: [addedEmbed] });
  }
};
