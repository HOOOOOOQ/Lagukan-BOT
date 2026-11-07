'use strict';

const os = require('node:os');
const { SlashCommandBuilder, version: djsVersion } = require('discord.js');
const { Constants } = require('shoukaku');
const { config } = require('../../../config/config');
const { createBaseEmbed } = require('../../utils/embeds');
const { formatUptime } = require('../../utils/formatters');

module.exports = {
  category: 'information',
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('Tampilkan informasi identitas, developer, dan arsitektur teknis bot LaguKan'),

  async execute(interaction, client) {
    const isTermux = Boolean(process.env.TERMUX_VERSION || process.platform === 'android');
    const platformLabel = isTermux
      ? `Android Termux (${os.arch()})`
      : `${os.type()} ${os.arch()}`;
    const voiceInfo = client.playerManager.getVoiceRuntimeInfo();
    const shoukakuLabel = String(Constants.ShoukakuClientInfo || 'Shoukaku v4').split(' ')[0];

    const embed = createBaseEmbed(config.colors.primary)
      .setTitle(`🎵 Tentang ${config.bot.name}`)
      .setDescription(
        `**${config.bot.name}** adalah Discord Music Bot berbahasa Indonesia yang dirancang ringan, modular, dan stabil untuk dijalankan pada **Android Termux** maupun server Linux.\n` +
        `Mendukung pemutaran multi-sumber (YouTube, YouTube Music, pencocokan metadata Spotify, SoundCloud, dan Direct Audio URL).`
      )
      .addFields(
        { name: '🤖 Nama Bot', value: `\`${config.bot.name}\``, inline: true },
        { name: '👨‍💻 Developer', value: `\`${config.bot.developer}\``, inline: true },
        { name: '🏷️ Versi', value: `\`v${config.bot.version}\``, inline: true },
        { name: '🟢 Runtime', value: `\`Node.js ${process.version}\``, inline: true },
        { name: '📚 Discord.js', value: `\`v${djsVersion}\``, inline: true },
        { name: '🎙️ @discordjs/voice', value: `\`v${voiceInfo.voiceLibVersion}\``, inline: true },
        { name: '🎚️ Audio Client', value: `\`${shoukakuLabel} (Lavalink)\``, inline: true },
        { name: '🗄️ Database', value: '`SQLite (sql.js WASM)`', inline: true },
        { name: '📱 Lingkungan OS', value: `\`${platformLabel}\``, inline: true },
        { name: '⏱️ Uptime Bot', value: `\`${formatUptime(client.uptime || 0)}\``, inline: false }
      );

    if (client.user?.displayAvatarURL) {
      embed.setThumbnail(client.user.displayAvatarURL({ size: 256 }));
    }

    return interaction.reply({ embeds: [embed] });
  }
};
