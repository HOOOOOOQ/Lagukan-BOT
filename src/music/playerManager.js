'use strict';

const { ChannelType } = require('discord.js');
const {
  getVoiceConnection,
  VoiceConnectionStatus,
  generateDependencyReport,
  version: voiceLibVersion
} = require('@discordjs/voice');
const { Constants } = require('shoukaku');
const { config } = require('../../config/config');
const { MusicPlayer } = require('./musicPlayer');
const { AppError, ErrorCodes } = require('../utils/errorHandler');
const logger = require('../utils/logger').child('PlayerManager');

class PlayerManager {
  /**
   * @param {import('../client')} client
   */
  constructor(client) {
    this.client = client;
    /** @type {Map<string, MusicPlayer>} */
    this.players = new Map();
    /** @type {Map<string, Promise<MusicPlayer>>} */
    this.pendingJoins = new Map();
    /** @type {Map<string, number[]>} */
    this.reconnectAttempts = new Map();
  }

  get(guildId) {
    return this.players.get(String(guildId)) || null;
  }

  has(guildId) {
    return this.players.has(String(guildId));
  }

  get activeCount() {
    return this.players.size;
  }

  get playingCount() {
    let count = 0;
    for (const mp of this.players.values()) {
      if (mp.playing && !mp.paused) count += 1;
    }
    return count;
  }

  /**
   * Mengambil node Lavalink yang sedang CONNECTED.
   */
  getAvailableNode() {
    const shoukaku = this.client.shoukaku;
    if (!shoukaku) return null;

    const ideal = shoukaku.getIdealNode();
    if (ideal && ideal.state === Constants.State.CONNECTED) {
      return ideal;
    }

    for (const node of shoukaku.nodes.values()) {
      if (node.state === Constants.State.CONNECTED) {
        return node;
      }
    }

    return null;
  }

  requireAvailableNode() {
    const node = this.getAvailableNode();
    if (!node) {
      throw new AppError(
        ErrorCodes.LAVALINK_OFFLINE,
        'Server audio **Lavalink** saat ini sedang offline atau sedang menyambung ulang. Pastikan proses Java Lavalink aktif, lalu coba beberapa saat lagi.'
      );
    }
    return node;
  }

  /**
   * Memastikan tidak ada koneksi lokal @discordjs/voice yang bertabrakan dengan konektor Lavalink/Shoukaku,
   * sekaligus menyediakan diagnostik status voice.
   */
  ensureCleanLocalVoiceAdapter(guildId) {
    const localConn = getVoiceConnection(String(guildId));
    if (localConn && localConn.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        localConn.destroy();
      } catch {
        // Abaikan jika sudah tertutup
      }
    }
  }

  getVoiceRuntimeInfo() {
    return {
      voiceLibVersion,
      report: generateDependencyReport()
    };
  }

  /**
   * Mengambil diagnostik aman status koneksi voice Discord & Shoukaku untuk sebuah server
   * TANPA pernah menampilkan voice token rahasia.
   */
  getVoiceDiagnostics(guildId) {
    const id = String(guildId);
    const conn = this.client.shoukaku?.connections?.get(id) || null;
    const shoukakuPlayer = this.client.shoukaku?.players?.get(id) || null;
    const guild = this.client.guilds?.cache?.get(id) || null;
    const botVoiceChannelId = guild?.members?.me?.voice?.channelId || null;

    const stateNames = {
      0: 'CONNECTING',
      1: 'CONNECTED',
      2: 'DISCONNECTING',
      3: 'DISCONNECTED'
    };

    let endpointHost = null;
    if (conn?.serverUpdate?.endpoint) {
      endpointHost = String(conn.serverUpdate.endpoint).split(':')[0];
    }

    return {
      botVoiceChannelId,
      shoukakuState: conn ? stateNames[conn.state] || `STATE_${conn.state}` : 'NONE',
      channelId: conn?.channelId || botVoiceChannelId || null,
      hasSessionId: Boolean(conn?.sessionId),
      hasServerUpdate: Boolean(conn?.serverUpdate?.endpoint && conn?.serverUpdate?.token),
      endpointHost,
      region: conn?.region || null,
      deafened: Boolean(conn?.deafened),
      muted: Boolean(conn?.muted),
      hasLavalinkPlayer: Boolean(shoukakuPlayer),
      voicePingMs: typeof shoukakuPlayer?.ping === 'number' ? shoukakuPlayer.ping : null
    };
  }

  /**
   * Membuat atau mengambil sesi MusicPlayer untuk sebuah server, otomatis bergabung ke voice channel.
   */
  async getOrCreate({ guild, voiceChannel, textChannelId = null }) {
    const guildId = String(guild.id);
    const existing = this.players.get(guildId);

    if (existing && !existing.destroyed) {
      if (textChannelId) {
        existing.textChannelId = String(textChannelId);
      }
      // Pastikan koneksi Shoukaku masih hidup
      if (existing.player && this.client.shoukaku.players.has(guildId)) {
        return existing;
      }
    }

    if (this.pendingJoins.has(guildId)) {
      return this.pendingJoins.get(guildId);
    }

    const joinPromise = this._createSession({ guild, voiceChannel, textChannelId, existing });
    this.pendingJoins.set(guildId, joinPromise);

    try {
      return await joinPromise;
    } finally {
      this.pendingJoins.delete(guildId);
    }
  }

  async _createSession({ guild, voiceChannel, textChannelId, existing = null }) {
    const guildId = String(guild.id);
    const node = this.requireAvailableNode();
    this.ensureCleanLocalVoiceAdapter(guildId);

    if (this.client.audioDiagnostics) {
      this.client.audioDiagnostics.recordStage(
        guildId,
        4,
        'Inisialisasi Sesi Player',
        `node="${node.name}", channel="#${voiceChannel.name || voiceChannel.id}"`
      );
    }

    // Jika terdapat sisa koneksi Shoukaku menggantung tanpa player, bersihkan terlebih dahulu
    if (
      this.client.shoukaku.connections.has(guildId) &&
      !this.client.shoukaku.players.has(guildId)
    ) {
      await this.client.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
    }

    if (this.client.audioDiagnostics) {
      this.client.audioDiagnostics.recordStage(
        guildId,
        5,
        'Bergabung ke Voice Channel Discord',
        `channelId=${voiceChannel.id}`
      );
    }

    let shoukakuPlayer;
    try {
      shoukakuPlayer = await this.client.shoukaku.joinVoiceChannel({
        guildId,
        channelId: String(voiceChannel.id),
        shardId: guild.shardId ?? 0,
        deaf: true,
        mute: false
      });
    } catch (err) {
      logger.error(`Gagal bergabung ke voice channel ${voiceChannel.id} di guild ${guildId}`, err);
      if (this.client.audioDiagnostics) {
        this.client.audioDiagnostics.recordTrackError({
          guildId,
          nodeName: node.name,
          track: { info: { title: `Join #${voiceChannel.name || voiceChannel.id}`, sourceName: 'discord-voice' } },
          stage: 'VOICE_JOIN',
          rawException: err
        });
      }
      throw new AppError(
        ErrorCodes.VOICE_CONNECTION_FAILED,
        `Gagal terhubung ke voice channel <#${voiceChannel.id}>. Periksa izin bot (\`Connect\` & \`Speak\`) serta koneksi Lavalink.`,
        { cause: err }
      );
    }

    const voiceDiag = this.getVoiceDiagnostics(guildId);
    if (this.client.audioDiagnostics) {
      this.client.audioDiagnostics.recordStage(
        guildId,
        6,
        'Handshake Voice State & Voice Server Siap',
        `state=${voiceDiag.shoukakuState}, session=${voiceDiag.hasSessionId}, endpoint=${voiceDiag.endpointHost || 'ready'}`
      );
    }

    // Jika channel bertipe Stage Channel, coba aktifkan pembicara otomatis
    if (voiceChannel.type === ChannelType.GuildStageVoice) {
      setTimeout(async () => {
        try {
          const me = guild.members.me || (await guild.members.fetchMe());
          if (me?.voice?.suppress) {
            await me.voice.setSuppressed(false).catch(async () => {
              await me.voice.setRequestToSpeak(true).catch(() => {});
            });
          }
        } catch {
          // Abaikan jika tidak memiliki izin Stage Moderator
        }
      }, 1200);
    }

    const guildSettings = this.client.guildsRepo.getSettings(guildId);
    const nativeBroken = this.client.audioDiagnostics?.isNativeDecoderBroken(
      shoukakuPlayer.node?.name || node.name
    );

    if (existing && !existing.destroyed) {
      existing.voiceChannelId = String(voiceChannel.id);
      if (textChannelId) existing.textChannelId = String(textChannelId);
      if (nativeBroken && existing.volume !== config.music.opusPassthroughVolume) {
        existing.volume = config.music.opusPassthroughVolume;
      }
      existing.attachNewShoukakuPlayer(shoukakuPlayer);
      await shoukakuPlayer.setGlobalVolume(existing.volume).catch(() => {});
      return existing;
    }

    const musicPlayer = new MusicPlayer({
      client: this.client,
      manager: this,
      guildId,
      voiceChannelId: String(voiceChannel.id),
      textChannelId,
      shoukakuPlayer,
      guildSettings
    });

    if (nativeBroken && musicPlayer.volume !== config.music.opusPassthroughVolume) {
      musicPlayer.volume = config.music.opusPassthroughVolume;
    }

    await shoukakuPlayer.setGlobalVolume(musicPlayer.volume).catch(() => {});
    this.players.set(guildId, musicPlayer);
    logger.info(`[Guild ${guildId}] Terhubung ke voice channel #${voiceChannel.name} (${voiceChannel.id})`);
    return musicPlayer;
  }

  /**
   * Menghancurkan sesi MusicPlayer dan keluar dari voice channel server terkait.
   */
  async destroy(guildId, { skipLeave = false } = {}) {
    const id = String(guildId);
    const mp = this.players.get(id);

    if (mp) {
      await mp.updatePlayerMessage({ ended: true }).catch(() => {});
      mp.cleanupTimersAndListeners();
      this.players.delete(id);
    }

    if (!skipLeave && this.client.shoukaku) {
      await this.client.shoukaku.leaveVoiceChannel(id).catch((err) => {
        logger.debug(`leaveVoiceChannel(${id}) diabaikan: ${err.message}`);
      });
    }

    if (this.client.audioDiagnostics) {
      this.client.audioDiagnostics.clearGuildStage(id);
    }

    this.ensureCleanLocalVoiceAdapter(id);
  }

  /**
   * Pembatas percobaan auto-reconnect 24/7 agar tidak terjadi loop tak terbatas jika admin mengeluarkan bot paksa.
   */
  canAttemptAutoReconnect(guildId) {
    const id = String(guildId);
    const now = Date.now();
    const recent = (this.reconnectAttempts.get(id) || []).filter((t) => now - t < 60000);
    if (recent.length >= 3) {
      return false;
    }
    recent.push(now);
    this.reconnectAttempts.set(id, recent);
    return true;
  }

  /**
   * Memulihkan sesi voice 24/7 dari database SQLite ketika node Lavalink siap.
   */
  async restoreTwentyFourSevenSessions() {
    if (!this.getAvailableNode()) return;

    const savedRows = this.client.guildsRepo.getTwentyFourSevenGuilds();
    if (!savedRows.length) return;

    for (const row of savedRows) {
      const guild = this.client.guilds.cache.get(row.guild_id);
      if (!guild) continue;
      if (this.players.has(guild.id)) continue;

      try {
        const channel =
          guild.channels.cache.get(row.voice_channel_id) ||
          (await guild.channels.fetch(row.voice_channel_id).catch(() => null));

        if (!channel || !channel.isVoiceBased()) {
          this.client.guildsRepo.setTwentyFourSeven(guild.id, { enabled: false });
          continue;
        }

        await this.getOrCreate({
          guild,
          voiceChannel: channel,
          textChannelId: row.text_channel_id
        });
        logger.info(`[24/7] Berhasil memulihkan koneksi voice di server "${guild.name}" (${guild.id})`);
      } catch (err) {
        logger.warn(`[24/7] Gagal memulihkan koneksi di guild ${guild.id}: ${err.message}`);
      }
    }
  }

  /**
   * Mencoba memulihkan pemutaran aktif apabila node Lavalink baru saja tersambung kembali.
   */
  async recoverInterruptedPlayers() {
    if (!this.getAvailableNode()) return;

    for (const [guildId, mp] of this.players.entries()) {
      if (mp.destroyed) continue;
      if (this.client.shoukaku.players.has(guildId)) continue;

      const guild = this.client.guilds.cache.get(guildId);
      const voiceChannel = guild?.channels?.cache?.get(mp.voiceChannelId);
      if (!guild || !voiceChannel) continue;

      try {
        const savedTrack = mp.currentTrack;
        const savedPos = mp.lastPosition || 0;
        await this._createSession({
          guild,
          voiceChannel,
          textChannelId: mp.textChannelId,
          existing: mp
        });
        if (savedTrack) {
          await mp.playSpecificTrack(savedTrack, { startPositionMs: savedPos });
          logger.info(`[Recovery] Berhasil melanjutkan pemutaran di guild ${guildId}`);
        }
      } catch (err) {
        logger.warn(`[Recovery] Gagal memulihkan player di guild ${guildId}: ${err.message}`);
      }
    }
  }

  async destroyAll() {
    const ids = [...this.players.keys()];
    for (const id of ids) {
      await this.destroy(id);
    }
  }
}

module.exports = {
  PlayerManager
};
