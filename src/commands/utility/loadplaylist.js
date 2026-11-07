'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess } = require('../../utils/permissions');
const { buildPlaylistAddedEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('loadplaylist')
    .setDescription('Muat dan putar daftar lagu dari playlist tersimpan di database')
    .addStringOption((opt) =>
      opt
        .setName('nama')
        .setDescription('Nama playlist tersimpan yang ingin dimuat')
        .setRequired(true)
        .setAutocomplete(true)
        .setMaxLength(50)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('acak')
        .setDescription('Acak urutan lagu dari playlist sebelum dimasukkan ke antrean')
        .setRequired(false)
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
        name: truncate(
          `${p.name} (${p.track_count} lagu${p.owner_id !== interaction.user.id ? ' • Publik' : ''})`,
          100
        ),
        value: p.name
      }));
    await interaction.respond(filtered);
  },

  async execute(interaction, client) {
    const name = interaction.options.getString('nama', true).trim();
    const shouldShuffle = interaction.options.getBoolean('acak') || false;

    const playlist = client.playlistsRepo.findAccessiblePlaylist(
      interaction.user.id,
      interaction.guildId,
      name
    );

    if (!playlist) {
      throw new AppError(
        ErrorCodes.TRACK_NOT_FOUND,
        `Playlist bernama **${name}** tidak ditemukan. Gunakan \`/playlist list\` untuk melihat daftar playlist tersimpan.`
      );
    }

    const dbTracks = client.playlistsRepo.getTracks(playlist.id);
    if (dbTracks.length === 0) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        `Playlist **${playlist.name}** tidak memiliki lagu di dalamnya.`,
        { isWarning: true }
      );
    }

    const existing = client.playerManager.get(interaction.guildId);
    const { userChannel } = validateVoiceAccess(interaction, existing, {
      requireBotInVoice: false
    });
    client.playerManager.requireAvailableNode();

    await interaction.deferReply();

    const musicPlayer = await client.playerManager.getOrCreate({
      guild: interaction.guild,
      voiceChannel: userChannel,
      textChannelId: interaction.channelId
    });

    const tracksToQueue = dbTracks.map((row) => ({
      encoded: row.encoded || null,
      info: {
        identifier: row.identifier || '',
        isSeekable: true,
        author: row.author || 'Artis Tidak Diketahui',
        length: Number(row.duration || 0),
        isStream: false,
        position: 0,
        title: row.title || 'Tanpa Judul',
        uri: row.uri || '',
        artworkUrl: row.artwork_url || null,
        isrc: null,
        sourceName: row.source_name || 'saved-playlist'
      },
      requester: {
        id: interaction.user.id,
        tag: interaction.user.tag
      },
      originalSource: row.source_name || 'saved-playlist',
      matchedVia: null,
      unresolved: !row.encoded,
      searchQuery: `${row.title} ${row.author}`.trim()
    }));

    if (shouldShuffle && tracksToQueue.length > 1) {
      for (let i = tracksToQueue.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = tracksToQueue[i];
        tracksToQueue[i] = tracksToQueue[j];
        tracksToQueue[j] = tmp;
      }
    }

    const wasPlaying = Boolean(musicPlayer.playing && musicPlayer.currentTrack);
    const added = musicPlayer.queue.enqueueMany(tracksToQueue);

    if (!wasPlaying) {
      await musicPlayer.playIfIdle();
    } else {
      await musicPlayer.updatePlayerMessage();
    }

    const embed = buildPlaylistAddedEmbed(
      {
        name: `💾 ${playlist.name}`,
        source: 'Saved Playlist (SQLite)',
        note: shouldShuffle ? 'Urutan lagu telah diacak sesuai permintaan.' : undefined
      },
      added,
      interaction.user
    );

    return interaction.editReply({ embeds: [embed] });
  }
};
