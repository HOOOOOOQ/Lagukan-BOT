'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { config } = require('../../../config/config');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed, buildInfoEmbed } = require('../../utils/embeds');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Lihat atau atur volume pemutaran musik (0 - 200%)')
    .addIntegerOption((opt) =>
      opt
        .setName('level')
        .setDescription('Tingkat volume baru antara 0 hingga 200%')
        .setRequired(false)
        .setMinValue(config.music.minVolume)
        .setMaxValue(config.music.maxVolume)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('simpan_default')
        .setDescription('Simpan sebagai volume default server di database (khusus DJ/Admin)')
        .setRequired(false)
    ),

  async execute(interaction, client) {
    const level = interaction.options.getInteger('level');
    const saveDefault = interaction.options.getBoolean('simpan_default') || false;
    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    const musicPlayer = client.playerManager.get(interaction.guildId);

    if (level === null) {
      const currentVol = musicPlayer ? musicPlayer.volume : guildSettings.default_volume;
      return interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Informasi Volume Musik',
            `🔊 **Volume Sesi Saat Ini:** \`${currentVol}%\`\n` +
            `💾 **Volume Default Server:** \`${guildSettings.default_volume}%\`\n\n` +
            `Gunakan \`/volume level:100\` untuk mengubah volume pemutar.`
          )
        ]
      });
    }

    if (saveDefault) {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'admin_or_dj');
      client.guildsRepo.setDefaultVolume(interaction.guildId, level);
    }

    if (musicPlayer && !musicPlayer.destroyed) {
      validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });
      assertControlPermission(interaction, musicPlayer, guildSettings, 'track');
      await musicPlayer.setVolume(level);
    } else if (!saveDefault) {
      // Jika sedang tidak memutar lagu, otomatis tawarkan atau simpan jika pengguna adalah DJ/Admin
      validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });
    }

    const icon = level === 0 ? '🔇' : level < 60 ? '🔉' : '🔊';
    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Volume Diperbarui',
          `${icon} Volume pemutar diatur ke **\`${level}%\`**${
            saveDefault ? ' dan disimpan sebagai **Volume Default Server**.' : '.'
          }`
        )
      ]
    });
  }
};
