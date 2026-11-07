'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('replay')
    .setDescription('Ulangi lagu yang sedang diputar kembali dari awal (00:00)'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'track');

    const track = await musicPlayer.replay();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Mengulang Lagu dari Awal',
          `🔄 Mengulang pemutaran **${truncate(track?.info?.title || 'lagu', 120)}** dari \`00:00\`.`
        )
      ]
    });
  }
};
