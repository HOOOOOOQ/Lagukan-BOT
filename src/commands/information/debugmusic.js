'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { Constants } = require('shoukaku');
const { config } = require('../../../config/config');
const { createBaseEmbed } = require('../../utils/embeds');
const { formatDuration, formatUptime, truncate } = require('../../utils/formatters');
const {
  detectRuntimeEnvironment,
  inspectDaveSupport,
  detectLocalJavaVersion,
  inspectLocalLavalinkConfig
} = require('../../music/audioDiagnostics');
const logger = require('../../utils/logger');

const SHARD_STATUS_LABELS = {
  0: '🟢 READY',
  1: '🟡 CONNECTING',
  2: '🟡 RECONNECTING',
  3: '⚪ IDLE',
  4: '🟡 NEARLY',
  5: '🔴 DISCONNECTED',
  6: '🟡 WAITING_FOR_GUILDS',
  7: '🟡 IDENTIFYING',
  8: '🟡 RESUMING'
};

const NODE_STATE_LABELS = {
  [Constants.State.CONNECTING]: '🟡 CONNECTING',
  [Constants.State.CONNECTED]: '🟢 CONNECTED',
  [Constants.State.DISCONNECTING]: '🟠 DISCONNECTING',
  [Constants.State.DISCONNECTED]: '🔴 DISCONNECTED'
};

module.exports = {
  category: 'information',
  allowDM: false,
  data: new SlashCommandBuilder()
    .setName('debugmusic')
    .setDescription('Tampilkan diagnostik teknis lengkap sistem audio, Lavalink, decoder, & voice Discord')
    .addBooleanOption((opt) =>
      opt
        .setName('publik')
        .setDescription('Tampilkan hasil diagnostik secara publik di channel ini (default: tersembunyi)')
        .setRequired(false)
    ),

  async execute(interaction, client) {
    const isPublic = interaction.options?.getBoolean?.('publik') || false;
    await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

    const runtime = client.audioDiagnostics?.runtime || detectRuntimeEnvironment();
    const localYaml = inspectLocalLavalinkConfig();

    // 1. Discord Connection Status
    const wsStatus = client.ws?.status ?? 0;
    const wsPing = typeof client.ws?.ping === 'number' ? `${Math.round(client.ws.ping)} ms` : 'N/A';
    const discordStatusText =
      `Status: **${SHARD_STATUS_LABELS[wsStatus] || `CODE_${wsStatus}`}**\n` +
      `Ping Gateway: \`${wsPing}\` | Uptime Bot: \`${formatUptime(process.uptime() * 1000)}\``;

    // 2, 3, 4, 6, 7. Lavalink Node, Version, Java, Plugins, & Active YouTube Clients
    const nodes = [...(client.shoukaku?.nodes?.values?.() || [])];
    const primaryNode = client.playerManager.getAvailableNode() || nodes[0] || null;

    let nodeInfo = primaryNode?.info || null;
    if (
      primaryNode &&
      primaryNode.state === Constants.State.CONNECTED &&
      !nodeInfo &&
      typeof primaryNode.rest?.getLavalinkInfo === 'function'
    ) {
      try {
        nodeInfo = await primaryNode.rest.getLavalinkInfo();
        if (nodeInfo) primaryNode.info = nodeInfo;
      } catch {
        // Abaikan jika endpoint info sedang sibuk
      }
    }

    let lavalinkConnText = '🔴 Tidak ada node Lavalink dikonfigurasi';
    if (primaryNode) {
      const stateLabel = NODE_STATE_LABELS[primaryNode.state] || `STATE_${primaryNode.state}`;
      const authState = client.audioDiagnostics?.getNodeAuthStatus?.(primaryNode.name);
      const authLabel =
        primaryNode.state === Constants.State.CONNECTED
          ? '🟢 Terautentikasi'
          : authState && authState.authenticated === false
          ? '🔴 Ditolak (HTTP 401/403 — Cek Password!)'
          : '🟡 Menunggu Handshake';
      const stats = primaryNode.stats;
      const frameText = stats?.frameStats
        ? ` | Frames: \`sent=${stats.frameStats.sent}, nulled=${stats.frameStats.nulled}, deficit=${stats.frameStats.deficit}\``
        : '';
      lavalinkConnText =
        `Node **${primaryNode.name}**: **${stateLabel}** | WS Auth: **${authLabel}**\n` +
        `Session Aktif: \`${primaryNode.sessionId ? 'Ya' : 'Tidak'}\` | Reconnects: \`${primaryNode.reconnects || 0}\`\n` +
        `Players Node: \`${stats ? `${stats.playingPlayers}/${stats.players}` : '0/0'}\`${frameText}`;
    }

    const lavalinkVersion = nodeInfo?.version?.semver
      ? `v${nodeInfo.version.semver} (Lavaplayer \`${nodeInfo.lavaplayer || 'unknown'}\`)`
      : primaryNode?.state === Constants.State.CONNECTED
      ? 'Terhubung (info versi belum dimuat)'
      : 'Tidak tersedia (Lavalink offline)';

    const javaVersion = nodeInfo?.jvm
      ? `JVM \`${nodeInfo.jvm}\` (Lavalink)`
      : detectLocalJavaVersion() || 'Tidak terdeteksi (periksa instalasi OpenJDK)';

    const envLabel = runtime.isTermux
      ? `Android Termux${runtime.termuxVersion ? ` v${runtime.termuxVersion}` : ''} (Bionic${runtime.hasProotDistro ? ' + proot-distro siap' : ''})`
      : `${runtime.platform}`;

    const runtimeVersionsText =
      `Lavalink: **${lavalinkVersion}**\n` +
      `Java: \`${truncate(javaVersion, 80)}\` | Node.js: \`${runtime.nodeVersion}\`\n` +
      `OS & CPU: \`${envLabel}\` | Arch: \`${runtime.arch}\` (\`${runtime.cpuCores} Core\`)`;

    // Plugins & Source Managers
    const pluginsList = Array.isArray(nodeInfo?.plugins) && nodeInfo.plugins.length > 0
      ? nodeInfo.plugins.map((p) => `\`${p.name}@${truncate(p.version, 20)}\``).join(', ')
      : primaryNode?.state === Constants.State.CONNECTED
      ? '*Tidak ada plugin eksternal terdeteksi*'
      : '*Menunggu koneksi Lavalink*';

    const sourcesList = Array.isArray(nodeInfo?.sourceManagers) && nodeInfo.sourceManagers.length > 0
      ? nodeInfo.sourceManagers.map((s) => `\`${s}\``).join(', ')
      : '*Menunggu koneksi Lavalink*';

    // Active YouTube Clients & Circuit Breaker Health
    const ytHealth = primaryNode
      ? client.audioDiagnostics?.getYoutubeHealth?.(primaryNode.name)
      : null;
    const ytHealthLine = ytHealth
      ? `\n🟠 **Circuit-Breaker YouTube Aktif** (\`${ytHealth.code}\`): Pencarian otomatis diprioritaskan ke **SoundCloud / Bandcamp**.`
      : '';

    let ytClientsText;
    if (localYaml.found && localYaml.youtubeClients.length > 0) {
      const clientTags = localYaml.youtubeClients.map((c) => `\`${c}\``).join(' → ');
      const warnNonOpus =
        localYaml.nonOpusClients.length > 0 && runtime.isAndroidBionic
          ? `\n⚠️ Peringatan: Client \`${localYaml.nonOpusClients.join(', ')}\` hanya menghasilkan AAC (bukan Opus) dan membutuhkan runtime \`glibc\`.`
          : '';
      ytClientsText =
        `${clientTags}\n` +
        `ClientOptions: \`${localYaml.hasClientOptions ? 'Aktif' : 'Default'}\` | Remote Cipher: \`${localYaml.hasRemoteCipher ? 'Aktif' : 'Tidak'}\` | OAuth: \`${localYaml.oauthEnabled ? 'Aktif' : 'Nonaktif'}\`${warnNonOpus}${ytHealthLine}`;
    } else {
      const hasYtPlugin = (nodeInfo?.plugins || []).some((p) => /youtube/i.test(p.name));
      ytClientsText =
        (hasYtPlugin
          ? '`youtube-plugin` aktif pada Lavalink (file `application.yml` berada di direktori eksternal)'
          : 'Konfigurasi `application.yml` lokal tidak ditemukan di direktori kerja') + ytHealthLine;
    }

    // 8. Audio Decoder & DAVE E2EE Protocol Status
    const daveInfo = client.audioDiagnostics?.daveSupport || inspectDaveSupport();
    const musicPlayer = client.playerManager.get(interaction.guildId);
    const activeVol = musicPlayer ? musicPlayer.volume : config.music.defaultVolume;
    const activeFilter = musicPlayer ? musicPlayer.activeFilterKey : 'off';
    const isPureJavaOpusReady =
      activeVol === config.music.opusPassthroughVolume && activeFilter === 'off';
    const nativeNodeState = primaryNode
      ? client.audioDiagnostics?.getNodeNativeStatus(primaryNode.name)
      : null;
    const daveNodeState = primaryNode
      ? client.audioDiagnostics?.getNodeDaveStatus?.(primaryNode.name)
      : null;

    let decoderStatusText =
      `Pure-Java Opus Passthrough: **${isPureJavaOpusReady ? '🟢 AKTIF (Vol 100%, Tanpa Filter)' : `🟡 NONAKTIF (Vol ${activeVol}%, Filter ${activeFilter})`}**\n` +
      `Node.js DAVE E2EE: **${daveInfo.daveyLoaded ? `🟢 v${daveInfo.daveProtocolVersion} (@snazzah/davey ${daveInfo.daveyVersion} • ${daveInfo.daveBindingType})` : '🔴 Tidak Tersedia'}**\n` +
      `Codec & Cipher Node.js: \`${daveInfo.opusLibrary || 'none'}\` | AEAD: \`${daveInfo.hasAes256Gcm ? 'aes-256-gcm' : ''}${daveInfo.hasXChaCha20Poly1305 ? ' + xchacha20' : ''}\`\n`;

    if (daveNodeState?.daveBroken) {
      decoderStatusText +=
        `Lavalink DAVE (\`libdave-jvm\`): 🔴 **Gagal Dimuat (${daveNodeState.code})** — *Jalankan \`./scripts/start-lavalink-termux.sh\` (glibc) atau gunakan Direct DAVE Fallback*\n`;
    }
    if (nativeNodeState?.broken) {
      decoderStatusText +=
        `Native JNI (\`libconnector.so\`): 🔴 **Gagal Dimuat (${nativeNodeState.code})** — *Self-healing Opus Passthrough diaktifkan otomatis*`;
    } else if (runtime.isAndroidBionic) {
      decoderStatusText +=
        `Native JNI (\`libconnector.so\` / \`libdave\`): 🟡 **Mode Termux ARM64** *(Gunakan \`./scripts/start-lavalink-termux.sh\` untuk dukungan penuh AAC/glibc)*`;
    } else {
      decoderStatusText += `Native JNI (\`libconnector.so\`): 🟢 **Kompatibel (${runtime.platform}/${runtime.arch})**`;
    }

    // 9. Voice Connection Status
    const voiceDiag = client.playerManager.getVoiceDiagnostics(interaction.guildId);
    const voiceChannelMention = voiceDiag.channelId ? `<#${voiceDiag.channelId}>` : '`Tidak terhubung`';
    const voicePingStr = voiceDiag.voicePingMs !== null ? `${voiceDiag.voicePingMs} ms` : 'N/A';
    const udpLabel = voiceDiag.lavalinkVoiceConnected
      ? '🟢 AKTIF'
      : voiceDiag.channelId
      ? '🟡 Siap / Menunggu Track'
      : '⚪ Tidak Aktif';
    const txLabel = voiceDiag.audioPacketsSent ? '🟢 Mengirim Paket' : '⚪ Idle';
    const muteFlags = [
      voiceDiag.serverMute ? '🔴 SERVER_MUTE' : null,
      voiceDiag.muted ? '🟠 SELF_MUTE' : null,
      voiceDiag.suppressed ? '🟠 STAGE_SUPPRESSED' : null
    ]
      .filter(Boolean)
      .join(', ') || '🟢 Tidak Di-Mute';
    const voiceStatusText =
      `Channel: ${voiceChannelMention} | Shoukaku: \`${voiceDiag.shoukakuState}\`\n` +
      `Session ID: \`${voiceDiag.hasSessionId ? 'Siap' : 'Belum'}\` | Server Handshake: \`${voiceDiag.hasServerUpdate ? 'Siap' : 'Belum'}\`\n` +
      `UDP Voice: **${udpLabel}** | Paket Audio: **${txLabel}** | Mute: **${muteFlags}**\n` +
      `Endpoint: \`${voiceDiag.endpointHost || '-'}\` | Ping Suara: \`${voicePingStr}\``;

    // 10. Current Player State & Pipeline Stage
    const stageInfo = client.audioDiagnostics?.getGuildStage(interaction.guildId);
    let playerStateText;
    if (!musicPlayer || musicPlayer.destroyed) {
      playerStateText = '`IDLE` — Tidak ada sesi pemutar aktif di server ini.';
    } else {
      playerStateText =
        `State: **\`${musicPlayer.state}\`** | TrackStarted: \`${musicPlayer.trackStarted ? 'Ya' : 'Belum'}\` | Paused: \`${musicPlayer.paused ? 'Ya' : 'Tidak'}\`\n` +
        `Volume: \`${musicPlayer.volume}%\` | Filter: \`${musicPlayer.activeFilterLabel}\` | Loop: \`${musicPlayer.queue.loopMode}\` | 24/7: \`${musicPlayer.twentyFourSeven ? 'ON' : 'OFF'}\`\n` +
        `Antrean: \`${musicPlayer.queue.size} lagu\`${stageInfo ? ` | Tahap Terakhir: \`[${stageInfo.stage}/9] ${stageInfo.name}\`` : ''}`;
    }

    // 11. Current Track
    let currentTrackText = '*Tidak ada lagu yang sedang dimuat/diputar.*';
    if (musicPlayer?.currentTrack) {
      const t = musicPlayer.currentTrack;
      const pos = formatDuration(musicPlayer.getCurrentPosition(), t.info?.isStream);
      const dur = formatDuration(t.info?.length || 0, t.info?.isStream);
      const fbLabel = t.fallbackFrom ? ` *(Fallback dari ${t.fallbackFrom})*` : '';
      currentTrackText =
        `**${truncate(t.info?.title || 'Tanpa Judul', 90)}** — *${truncate(t.info?.author || 'Artis', 50)}*\n` +
        `Sumber: \`${t.info?.sourceName || 'unknown'}\`${fbLabel} | Posisi: \`${pos} / ${dur}\``;
    }

    // 12. Track Loading Errors (sanitized, zero secrets)
    const recentErrors = client.audioDiagnostics?.getRecentErrors(interaction.guildId, 4) || [];
    const errorsText =
      recentErrors.length > 0
        ? recentErrors
            .map((e) => {
              const relTime = `<t:${Math.floor(e.timestamp / 1000)}:R>`;
              const safeReason = logger.redactSecrets(e.reason);
              return `• ${relTime} **[${e.code}]** *(${truncate(e.trackTitle, 35)})*: ${truncate(safeReason, 130)}`;
            })
            .join('\n')
        : '✅ Tidak ada error pemuatan/dekode audio tercatat.';

    const embed = createBaseEmbed(
      nativeNodeState?.broken || !primaryNode || primaryNode.state !== Constants.State.CONNECTED
        ? config.colors.warning
        : config.colors.info
    )
      .setTitle(`🩺 Diagnostik Audio & Voice ${config.bot.name} (/debugmusic)`)
      .setDescription(
        `Laporan real-time pipa audio Discord & Lavalink untuk server **${truncate(interaction.guild?.name || 'Server', 60)}**.\n` +
        `*Seluruh kredensial, token, dan password disensor otomatis demi keamanan.*`
      )
      .addFields(
        { name: '🌐 1. Koneksi Discord Gateway', value: truncate(discordStatusText, 1020), inline: false },
        { name: '🎛️ 2. Koneksi Server Lavalink', value: truncate(lavalinkConnText, 1020), inline: false },
        { name: '⚙️ 3. Versi Lavalink, Java, Node.js & OS/CPU', value: truncate(runtimeVersionsText, 1020), inline: false },
        { name: '🔌 4. Status Plugin & Source Managers', value: truncate(`Plugins: ${pluginsList}\nSources: ${sourcesList}`, 1020), inline: false },
        { name: '📺 5. Client YouTube Aktif', value: truncate(ytClientsText, 1020), inline: false },
        { name: '🔊 6. Status Audio Decoder & ARM64', value: truncate(decoderStatusText, 1020), inline: false },
        { name: '📡 7. Koneksi Voice Discord Server Ini', value: truncate(voiceStatusText, 1020), inline: false },
        { name: '▶️ 8. State Pemutar Musik Saat Ini', value: truncate(playerStateText, 1020), inline: false },
        { name: '🎵 9. Lagu Saat Ini (Current Track)', value: truncate(currentTrackText, 1020), inline: false },
        { name: '⚠️ 10. Riwayat Error Pemuatan / Dekode Track', value: truncate(errorsText, 1020), inline: false }
      );

    return interaction.editReply({ embeds: [embed] });
  }
};
