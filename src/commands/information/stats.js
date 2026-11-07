'use strict';

const os = require('node:os');
const { SlashCommandBuilder } = require('discord.js');
const { Constants } = require('shoukaku');
const { config } = require('../../../config/config');
const { createBaseEmbed } = require('../../utils/embeds');
const { formatBytes, formatUptime } = require('../../utils/formatters');

module.exports = {
  category: 'information',
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Tampilkan statistik performa sistem, penggunaan memori, dan kesehatan node Lavalink'),

  async execute(interaction, client) {
    const mem = process.memoryUsage();
    const totalGuilds = client.guilds.cache.size;
    const totalMembers = client.guilds.cache.reduce(
      (sum, g) => sum + Number(g.memberCount || 0),
      0
    );
    const dbCounts = client.playlistsRepo.getGlobalCounts();

    const nodeDetails = [];
    for (const node of client.shoukaku.nodes.values()) {
      const isUp = node.state === Constants.State.CONNECTED;
      if (!isUp || !node.stats) {
        nodeDetails.push(
          `• **${node.name}**: ${isUp ? '🟢 Terhubung (menunggu statistik...)' : '🔴 Terputus'}`
        );
        continue;
      }

      const s = node.stats;
      const lavaLoad = ((s.cpu?.lavalinkLoad || 0) * 100).toFixed(1);
      const sysLoad = ((s.cpu?.systemLoad || 0) * 100).toFixed(1);
      nodeDetails.push(
        `• **${node.name}** (🟢 Online)\n` +
        `  └ Players: \`${s.playingPlayers}/${s.players}\` | RAM: \`${formatBytes(s.memory?.used)} / ${formatBytes(s.memory?.allocated)}\`\n` +
        `  └ CPU: \`Lavalink ${lavaLoad}% / Sys ${sysLoad}%\` | Uptime: \`${formatUptime(s.uptime)}\``
      );
    }

    const cpuCount = os.cpus()?.length || 1;
    const load1m = os.loadavg()[0]?.toFixed(2) || '0.00';

    const embed = createBaseEmbed(config.colors.info)
      .setTitle(`📊 Statistik Sistem ${config.bot.name}`)
      .addFields(
        { name: '🏠 Total Server', value: `\`${totalGuilds}\``, inline: true },
        { name: '👥 Estimasi Pengguna', value: `\`${totalMembers.toLocaleString('id-ID')}\``, inline: true },
        {
          name: '🎶 Sesi Musik Aktif',
          value: `\`${client.playerManager.playingCount} memutar / ${client.playerManager.activeCount} terhubung\``,
          inline: true
        },
        {
          name: '🧠 Memori Bot (RSS / Heap)',
          value: `\`${formatBytes(mem.rss)} / ${formatBytes(mem.heapUsed)}\``,
          inline: true
        },
        {
          name: '⚙️ CPU Host',
          value: `\`${cpuCount} Core (Load: ${load1m})\``,
          inline: true
        },
        {
          name: '💾 Playlist Tersimpan',
          value: `\`${dbCounts.playlists} playlist (${dbCounts.tracks} lagu)\``,
          inline: true
        },
        {
          name: '⏱️ Uptime Proses Node.js',
          value: `\`${formatUptime(process.uptime() * 1000)}\``,
          inline: false
        },
        {
          name: '🎚️ Kesehatan Server Lavalink',
          value: nodeDetails.join('\n') || 'Tidak ada node dikonfigurasi',
          inline: false
        }
      );

    return interaction.reply({ embeds: [embed] });
  }
};
