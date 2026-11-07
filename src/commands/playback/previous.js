'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('previous')
    .setDescription('Putar kembali lagu sebelumnya dari riwayat sesi pemutaran'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'track');

    await interaction.deferReply();
    const track = await musicPlayer.previous();

    return interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          'Memutar Lagu Sebelumnya',
          `⏮️ Kembali memutar **${truncate(track?.info?.title || 'lagu sebelumnya', 120)}** — *${truncate(track?.info?.author || '', 60)}*.`
        )
      ]
    });
  }
};
