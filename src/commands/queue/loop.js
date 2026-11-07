'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { formatLoopMode } = require('../../utils/formatters');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Atur mode pengulangan lagu atau seluruh antrean')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Pilih mode pengulangan')
        .setRequired(true)
        .addChoices(
          { name: '➡️ Mati (Off)', value: 'off' },
          { name: '🔂 Lagu Saat Ini (Track)', value: 'track' },
          { name: '🔁 Seluruh Antrean (Queue)', value: 'queue' }
        )
    ),

  async execute(interaction, client) {
    const mode = interaction.options.getString('mode', true);
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    musicPlayer.queue.setLoopMode(mode);
    await musicPlayer.updatePlayerMessage();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Mode Loop Diperbarui',
          `Mode pengulangan diatur ke **${formatLoopMode(mode)}**.`
        )
      ]
    });
  }
};
