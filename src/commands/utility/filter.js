'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getFilterChoices } = require('../../music/filters');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Terapkan efek filter audio real-time pada pemutar musik (Bassboost, Nightcore, 8D, dll.)')
    .addStringOption((opt) =>
      opt
        .setName('preset')
        .setDescription('Pilih preset efek audio yang ingin diterapkan')
        .setRequired(true)
        .addChoices(...getFilterChoices())
    ),

  async execute(interaction, client) {
    const presetKey = interaction.options.getString('preset', true);
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    if (!musicPlayer.currentTrack) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        'Putar sebuah lagu terlebih dahulu sebelum menerapkan efek filter audio.',
        { isWarning: true }
      );
    }

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    const applied = await musicPlayer.setFilter(presetKey);

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Filter Audio Diterapkan',
          `🎛️ Preset filter diubah ke **${applied.label}**.\n*${applied.description}*\n*(Catatan: perubahan filter pada Lavalink dapat membutuhkan 1–3 detik untuk terdengar).*`
        )
      ]
    });
  }
};
