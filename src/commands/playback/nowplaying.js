'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildMusicPlayerPayload, buildInfoEmbed } = require('../../utils/embeds');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Tampilkan detail lagu yang sedang diputar beserta panel kontrol interaktif'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    if (!musicPlayer || !musicPlayer.currentTrack) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        'Saat ini tidak ada lagu yang sedang diputar di server ini.',
        { isWarning: true }
      );
    }

    if (!musicPlayer.trackStarted) {
      return interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Memuat Aliran Audio...',
            `⏳ **${musicPlayer.currentTrack.info.title}** sedang dimuat dan didekode oleh server Lavalink. Panel *Now Playing* akan aktif segera setelah suara benar-benar mulai berputar.`
          )
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    await musicPlayer.disableOldPlayerMessage();
    const payload = buildMusicPlayerPayload(musicPlayer);
    await interaction.reply(payload);
    const sentMsg = await interaction.fetchReply().catch(() => null);
    if (sentMsg) {
      musicPlayer.textChannelId = interaction.channelId;
      musicPlayer.playerMessage = sentMsg;
    }
  }
};
