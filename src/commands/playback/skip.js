'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Lewati lagu yang sedang diputar ke lagu berikutnya dalam antrean'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'track');

    await interaction.deferReply();
    const { skippedTrack, nextTrack } = await musicPlayer.skip();

    const skippedTitle = truncate(skippedTrack?.info?.title || 'Lagu sebelumnya', 100);
    const nextInfo = nextTrack
      ? `\n🎶 Sekarang memutar: **${truncate(nextTrack.info.title, 100)}**`
      : '\n📭 Antrean telah habis.';

    return interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          'Lagu Dilewati',
          `⏭️ Melewati **${skippedTitle}**.${nextInfo}`
        )
      ]
    });
  }
};
