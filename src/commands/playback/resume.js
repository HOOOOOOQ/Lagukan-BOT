'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Lanjutkan pemutaran lagu yang sedang dijeda'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'track');

    await musicPlayer.resume();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Musik Dilanjutkan',
          `▶️ Melanjutkan pemutaran **${truncate(musicPlayer.currentTrack?.info?.title || 'lagu', 120)}**.`
        )
      ]
    });
  }
};
