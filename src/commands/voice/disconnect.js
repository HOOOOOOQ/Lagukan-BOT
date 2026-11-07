'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');

module.exports = {
  category: 'voice',
  data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Putuskan koneksi LaguKan dari voice channel dan bersihkan sesi musik'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    const { botChannelId } = validateVoiceAccess(interaction, musicPlayer, {
      requireBotInVoice: true,
      allowAdminOverride: true
    });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    if (musicPlayer) {
      musicPlayer.twentyFourSeven = false;
    }
    if (guildSettings.twenty_four_seven) {
      client.guildsRepo.setTwentyFourSeven(interaction.guildId, { enabled: false });
    }

    await client.playerManager.destroy(interaction.guildId);

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Keluar dari Voice Channel',
          `👋 LaguKan telah keluar dari <#${botChannelId}> dan membersihkan sesi pemutaran.`
        )
      ]
    });
  }
};
