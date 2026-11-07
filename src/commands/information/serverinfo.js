'use strict';

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { config } = require('../../../config/config');
const { createBaseEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Tampilkan informasi server Discord beserta status pengaturan LaguKan di server ini'),

  async execute(interaction, client) {
    const guild = interaction.guild;
    const settings = client.guildsRepo.getSettings(guild.id);
    const activePlayer = client.playerManager.get(guild.id);

    const textChannels = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText
    ).size;
    const voiceChannels = guild.channels.cache.filter((c) => c.isVoiceBased()).size;
    const createdUnix = Math.floor(guild.createdTimestamp / 1000);

    const playerStatus = activePlayer?.currentTrack
      ? `▶️ Memutar: **${truncate(activePlayer.currentTrack.info.title, 50)}** (${activePlayer.queue.size} antrean)`
      : activePlayer
        ? '🟡 Siaga di Voice Channel'
        : '⚪ Tidak Aktif';

    const embed = createBaseEmbed(config.colors.primary)
      .setTitle(`🏰 Informasi Server: ${guild.name}`)
      .addFields(
        { name: '🆔 ID Server', value: `\`${guild.id}\``, inline: true },
        { name: '👑 Pemilik', value: `<@${guild.ownerId}>`, inline: true },
        { name: '👥 Jumlah Anggota', value: `\`${guild.memberCount.toLocaleString('id-ID')}\``, inline: true },
        { name: '💬 Text / Voice Channel', value: `\`${textChannels}\` Text / \`${voiceChannels}\` Voice`, inline: true },
        { name: '💎 Level Boost', value: `\`Tier ${guild.premiumTier} (${guild.premiumSubscriptionCount || 0} Boost)\``, inline: true },
        { name: '📅 Dibuat Pada', value: `<t:${createdUnix}:D>`, inline: true },
        {
          name: `🎵 Konfigurasi ${config.bot.name}`,
          value:
            `• **Status Pemutar:** ${playerStatus}\n` +
            `• **Volume Default:** \`${settings.default_volume}%\`\n` +
            `• **DJ Mode:** \`${settings.dj_enabled ? 'AKTIF' : 'NONAKTIF'}\` ${settings.dj_role_id ? `(<@&${settings.dj_role_id}>)` : ''}\n` +
            `• **Mode 24/7:** \`${settings.twenty_four_seven ? 'AKTIF' : 'NONAKTIF'}\`\n` +
            `• **Autoplay:** \`${settings.autoplay ? 'AKTIF' : 'NONAKTIF'}\`\n` +
            `• **Music Channel:** ${settings.music_channel_id ? `<#${settings.music_channel_id}>` : '`Semua Channel`'}`,
          inline: false
        }
      );

    if (guild.iconURL()) {
      embed.setThumbnail(guild.iconURL({ size: 256 }));
    }

    return interaction.reply({ embeds: [embed] });
  }
};
