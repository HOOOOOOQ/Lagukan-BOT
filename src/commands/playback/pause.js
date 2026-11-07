'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Jeda lagu yang sedang diputar saat ini'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'track');

    await musicPlayer.pause();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Musik Dijeda',
          `⏸️ Pemutaran **${truncate(musicPlayer.currentTrack?.info?.title || 'lagu', 120)}** telah dijeda. Gunakan \`/resume\` untuk melanjutkan.`
        )
      ]
    });
  }
};
