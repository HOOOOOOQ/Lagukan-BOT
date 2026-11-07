'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { Constants } = require('shoukaku');
const { config } = require('../../../config/config');
const { createBaseEmbed } = require('../../utils/embeds');

module.exports = {
  category: 'information',
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Periksa latensi jaringan Discord Gateway, REST API, Lavalink, dan Database SQLite'),

  async execute(interaction, client) {
    const startRest = Date.now();
    await interaction.deferReply();
    const restLatency = Date.now() - startRest;
    const wsPing = Math.round(client.ws.ping);
    const dbLatency = client.db.ping();

    const nodeLines = [];
    for (const node of client.shoukaku.nodes.values()) {
      const connected = node.state === Constants.State.CONNECTED;
      nodeLines.push(
        `• **${node.name}**: ${connected ? '🟢 Terhubung' : '🔴 Terputus'}`
      );
    }

    const activeMp = interaction.guildId ? client.playerManager.get(interaction.guildId) : null;
    const voicePingText =
      activeMp?.player && activeMp.player.ping >= 0
        ? `\`${activeMp.player.ping} ms\``
        : '`Tidak sedang streaming`';

    const embed = createBaseEmbed(config.colors.success)
      .setTitle(`🏓 Pong! Status Latensi ${config.bot.name}`)
      .addFields(
        { name: '📡 Discord Gateway (WS)', value: `\`${wsPing} ms\``, inline: true },
        { name: '⚡ Discord REST API', value: `\`${restLatency} ms\``, inline: true },
        { name: '🗄️ Database SQLite', value: `\`${dbLatency} ms\``, inline: true },
        { name: '🔊 Voice Ping Server Ini', value: voicePingText, inline: true },
        {
          name: '🎛️ Status Node Lavalink',
          value: nodeLines.join('\n') || 'Belum ada node terdaftar',
          inline: false
        }
      );

    return interaction.editReply({ embeds: [embed] });
  }
};
