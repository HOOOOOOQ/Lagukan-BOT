'use strict';

const { QueueManager } = require('./queueManager');
const { getFilterPreset } = require('./filters');
const { findAutoplayTrack } = require('./autoplay');
const { DirectDaveVoiceSession } = require('./directVoiceEngine');
const {
  buildMusicPlayerPayload,
  buildErrorEmbed,
  buildInfoEmbed
} = require('../utils/embeds');
const { AppError, ErrorCodes } = require('../utils/errorHandler');
const logger = require('../utils/logger').child('MusicPlayer');
const { config } = require('../../config/config');

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

class MusicPlayer {
  /**
   * @param {object} options
   * @param {import('../client').LaguKanClient} options.client
   * @param {import('./playerManager').PlayerManager} options.manager
   * @param {string} options.guildId
   * @param {string} options.voiceChannelId
   * @param {string|null} options.textChannelId
   * @param {import('shoukaku').Player} options.shoukakuPlayer
   * @param {object} options.guildSettings
   */
  constructor({ client, manager, guildId, voiceChannelId, textChannelId, shoukakuPlayer, guildSettings }) {
    this.client = client;
    this.manager = manager;
    this.guildId = String(guildId);
    this.voiceChannelId = String(voiceChannelId);
    this.textChannelId = textChannelId ? String(textChannelId) : null;
    this.player = shoukakuPlayer;

    this.queue = new QueueManager(this.guildId);
    this.currentTrack = null;
    this.paused = false;
    this.playing = false;
    this.trackStarted = false;
    this.state = 'IDLE';
    this.destroyed = false;

    // Telemetry transport suara Discord (UDP / Koe / Direct DAVE v1 / paket RTP Opus)
    this.voiceConnected = false;
    this.voicePingMs = -1;
    this.audioPacketsSent = false;
    this._lastPacketLogAt = 0;
    this._lastVoiceCloseCode = null;
    this.usingDirectDaveVoice = false;
    /** @type {DirectDaveVoiceSession | null} */
    this.directVoiceSession = null;
    this._allowLoopbackDirectVoice = false;

    const savedVol = Number(guildSettings?.default_volume ?? config.music.defaultVolume);
    this.volume = savedVol > 0 ? savedVol : config.music.defaultVolume;
    this.twentyFourSeven = Boolean(guildSettings?.twenty_four_seven);
    this.autoplay = Boolean(guildSettings?.autoplay);

    this.activeFilterKey = 'off';
    this.activeFilterLabel = 'Normal';

    this.lastPosition = 0;
    this.lastPositionTimestamp = 0;
    this.consecutiveFailures = 0;
    this.suppressEndHandling = false;
    this.lastException = null;

    /** @type {Array<{ resolve: Function, timer: NodeJS.Timeout }>} */
    this._pendingStartWaiters = [];

    /** @type {import('discord.js').Message | null} */
    this.playerMessage = null;
    this.refreshInterval = null;
    this.idleTimer = null;
    this.emptyChannelTimer = null;
    this.updatingMessage = false;

    this.bindPlayerEvents(this.player);
  }

  _setState(newState, reason = '') {
    const prev = this.state;
    this.state = newState;
    if (prev !== newState) {
      logger.info(
        `[PlayerState] Audio player state: guild=${this.guildId}, ${prev} -> ${newState}${
          reason ? ` (${reason})` : ''
        }`
      );
    }
  }

  /**
   * Menentukan apakah player terhubung ke sesi WebSocket Lavalink nyata (asynchronous TrackStartEvent)
   * atau mock sinkron pada pengujian unit ringan.
   */
  isAsyncLavalinkSession() {
    return Boolean(
      this.player?.node?.ws ||
      this.player?.node?.sessionId ||
      this.player?._asyncLifecycle
    );
  }

  /**
   * Menentukan apakah node mendukung inspeksi transport suara Lavalink secara real-time
   * (selalu true pada node Shoukaku nyata yang memiliki WebSocket atau REST getPlayer).
   */
  hasLiveVoiceTransportCheck() {
    return Boolean(
      this.player?.node?.ws ||
      typeof this.player?.node?.rest?.getPlayer === 'function'
    );
  }

  bindPlayerEvents(shoukakuPlayer) {
    if (!shoukakuPlayer) return;

    shoukakuPlayer.on('start', (data) => {
      this.onTrackStart(data).catch((err) => logger.error('Error pada onTrackStart', err));
    });

    shoukakuPlayer.on('end', (data) => {
      this.onTrackEnd(data).catch((err) => logger.error('Error pada onTrackEnd', err));
    });

    shoukakuPlayer.on('exception', (data) => {
      this.onTrackException(data).catch((err) => logger.error('Error pada onTrackException', err));
    });

    shoukakuPlayer.on('stuck', (data) => {
      this.onTrackStuck(data).catch((err) => logger.error('Error pada onTrackStuck', err));
    });

    shoukakuPlayer.on('closed', (data) => {
      this.onWebSocketClosed(data).catch((err) => logger.error('Error pada onWebSocketClosed', err));
    });

    shoukakuPlayer.on('update', (data) => {
      this.onPlayerUpdate(data);
    });

    shoukakuPlayer.on('resumed', () => {
      logger.info(`[Guild ${this.guildId}] Sesi pemutar musik berhasil dipulihkan oleh Shoukaku.`);
    });
  }

  onPlayerUpdate(data) {
    if (!data?.state) return;

    this.lastPosition = Number(data.state.position || 0);
    this.lastPositionTimestamp = Date.now();

    const connected = Boolean(data.state.connected);
    const ping = typeof data.state.ping === 'number' ? data.state.ping : -1;
    this.voicePingMs = ping;

    if (connected && !this.voiceConnected) {
      this.voiceConnected = true;
      logger.info(
        `[VoiceUDP] ✅ UDP connection established: guild=${this.guildId}, connected=true, ping=${ping}ms`
      );
    }

    if (connected && this.playing && !this.paused) {
      const frameStats = this.player?.node?.stats?.frameStats || null;
      const now = Date.now();
      if (!this.audioPacketsSent || now - this._lastPacketLogAt >= 15000) {
        this.audioPacketsSent = true;
        this._lastPacketLogAt = now;
        logger.info(
          `[AudioTx] 📡 Audio packet transmission: guild=${this.guildId}, pos=${this.lastPosition}ms, ping=${ping}ms, framesSent=${
            frameStats ? frameStats.sent : 'streaming'
          }, nulled=${frameStats ? frameStats.nulled : 0}, deficit=${frameStats ? frameStats.deficit : 0}`
        );
      }
    } else if (!connected && this.voiceConnected) {
      this.voiceConnected = false;
      logger.warn(
        `[VoiceUDP] ⚠️ Transport suara UDP terputus sementara (guild=${this.guildId}, state.connected=false)`
      );
      if (this.playing && !this.paused) {
        this._resyncVoiceSessionToLavalink().catch(() => {});
      }
    }
  }

  async _resyncVoiceSessionToLavalink() {
    const conn = this.client.shoukaku?.connections?.get(this.guildId);
    if (
      conn?.sessionId &&
      conn?.serverUpdate?.token &&
      conn?.serverUpdate?.endpoint &&
      typeof this.player?.sendServerUpdate === 'function'
    ) {
      logger.info(
        `[DiscordVoice] Mengirim ulang kredensial sesi voice ke Lavalink (guild=${this.guildId}, channel=${
          conn.channelId || this.voiceChannelId
        })...`
      );
      await this.player.sendServerUpdate(conn);
    }
  }

  /**
   * Memastikan koneksi UDP & Discord Voice Gateway pada sisi Lavalink benar-benar terhubung
   * (state.connected === true) sebelum mengizinkan status berubah menjadi PLAYING.
   */
  async _verifyVoiceTransportReady() {
    if (!this.hasLiveVoiceTransportCheck()) {
      return { ok: true, skipped: true };
    }

    if (this.voiceConnected) {
      return { ok: true, ping: this.voicePingMs };
    }

    const timeoutMs = Number(process.env.VOICE_TRANSPORT_VERIFY_TIMEOUT_MS || 4000);
    const pollIntervalMs = 200;
    const startedAt = Date.now();
    let resynced = false;

    while (Date.now() - startedAt < timeoutMs) {
      if (this.destroyed || !this.playing) {
        return { ok: false, cancelled: true };
      }

      if (this._lastVoiceCloseCode === 4017) {
        return { ok: false, closeCode: 4017 };
      }

      if (this.voiceConnected) {
        return { ok: true, ping: this.voicePingMs };
      }

      if (typeof this.player?.node?.rest?.getPlayer === 'function') {
        const remotePlayer = await this.player.node.rest.getPlayer(this.guildId).catch(() => null);
        if (remotePlayer?.state?.connected === true) {
          this.voiceConnected = true;
          this.voicePingMs =
            typeof remotePlayer.state.ping === 'number' ? remotePlayer.state.ping : -1;
          this.lastPosition = Number(remotePlayer.state.position || this.lastPosition);
          this.lastPositionTimestamp = Date.now();
          this.audioPacketsSent = true;
          this._lastPacketLogAt = Date.now();

          const frameStats = this.player?.node?.stats?.frameStats || null;
          logger.info(
            `[VoiceUDP] ✅ UDP connection established: guild=${this.guildId}, connected=true, ping=${this.voicePingMs}ms`
          );
          logger.info(
            `[AudioTx] 📡 Audio packet transmission: guild=${this.guildId}, pos=${this.lastPosition}ms, ping=${this.voicePingMs}ms, framesSent=${
              frameStats ? frameStats.sent : 'streaming'
            }, nulled=${frameStats ? frameStats.nulled : 0}, deficit=${frameStats ? frameStats.deficit : 0}`
          );
          return { ok: true, ping: this.voicePingMs };
        }
      }

      if (!resynced && Date.now() - startedAt >= 800) {
        resynced = true;
        await this._resyncVoiceSessionToLavalink().catch(() => {});
      }

      await sleep(pollIntervalMs);
    }

    return { ok: false };
  }

  attachNewShoukakuPlayer(newShoukakuPlayer) {
    if (this.player && this.player !== newShoukakuPlayer) {
      this.player.removeAllListeners();
    }
    this.voiceConnected = false;
    this.audioPacketsSent = false;
    this.player = newShoukakuPlayer;
    this.bindPlayerEvents(newShoukakuPlayer);
  }

  _registerStartWaiter(timeoutMs = config.music.trackStartTimeoutMs) {
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this._pendingStartWaiters = this._pendingStartWaiters.filter((w) => w !== waiter);
          resolve({
            started: this.trackStarted,
            timedOut: !this.trackStarted,
            track: this.currentTrack,
            diagnosis: this.lastException?.diagnosis || null
          });
        }, timeoutMs)
      };
      if (typeof waiter.timer.unref === 'function') {
        waiter.timer.unref();
      }
      this._pendingStartWaiters.push(waiter);
    });
  }

  _resolvePendingStartWaiters(result) {
    if (!this._pendingStartWaiters.length) return;
    const waiters = this._pendingStartWaiters.splice(0, this._pendingStartWaiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      try {
        waiter.resolve(result);
      } catch {
        // Abaikan
      }
    }
  }

  getCurrentPosition() {
    if (!this.currentTrack) return 0;
    if (this.usingDirectDaveVoice && this.directVoiceSession) {
      const directPos = this.lastPosition + this.directVoiceSession.getPlaybackPositionMs();
      const maxLen = Number(this.currentTrack.info?.length || 0);
      return maxLen > 0 && !this.currentTrack.info?.isStream ? Math.min(maxLen, directPos) : directPos;
    }
    if (this.paused || !this.trackStarted || !this.lastPositionTimestamp) {
      return this.lastPosition;
    }
    const preset = getFilterPreset(this.activeFilterKey);
    const speed = preset?.payload?.timescale?.speed || 1.0;
    const elapsed = Math.max(0, Date.now() - this.lastPositionTimestamp) * speed;
    const estimated = Math.floor(this.lastPosition + elapsed);
    const maxLen = Number(this.currentTrack.info?.length || 0);
    if (maxLen > 0 && !this.currentTrack.info?.isStream) {
      return Math.min(maxLen, estimated);
    }
    return estimated;
  }

  getEstimatedWaitMs(upcomingIndex0Based = 0) {
    let waitMs = 0;
    if (this.currentTrack && !this.currentTrack.info?.isStream) {
      const remaining = Math.max(0, Number(this.currentTrack.info.length || 0) - this.getCurrentPosition());
      waitMs += remaining;
    }
    for (let i = 0; i < upcomingIndex0Based && i < this.queue.tracks.length; i += 1) {
      const t = this.queue.tracks[i];
      if (t && !t.info?.isStream) {
        waitMs += Number(t.info?.length || 0);
      }
    }
    return waitMs;
  }

  async getTextChannel() {
    if (!this.textChannelId) return null;
    try {
      const cached = this.client.channels.cache.get(this.textChannelId);
      if (cached) return cached;
      return await this.client.channels.fetch(this.textChannelId);
    } catch {
      return null;
    }
  }

  async sendChannelEmbed(embed) {
    const channel = await this.getTextChannel();
    if (!channel || typeof channel.send !== 'function') return null;
    try {
      return await channel.send({ embeds: [embed] });
    } catch (err) {
      logger.debug(`Gagal mengirim pesan notifikasi ke channel ${this.textChannelId}: ${err.message}`);
      return null;
    }
  }

  startRefreshLoop() {
    this.stopRefreshLoop();
    this.refreshInterval = setInterval(() => {
      if (this.destroyed || this.paused || !this.playing || !this.trackStarted || !this.currentTrack) return;
      this.updatePlayerMessage().catch(() => {});
    }, config.music.playerRefreshIntervalMs);
    if (typeof this.refreshInterval.unref === 'function') {
      this.refreshInterval.unref();
    }
  }

  stopRefreshLoop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  startIdleTimer() {
    this.clearIdleTimer();
    if (this.twentyFourSeven) return;

    this.idleTimer = setTimeout(async () => {
      if (this.destroyed || this.playing || this.twentyFourSeven) return;
      logger.info(`[Guild ${this.guildId}] Idle timeout tercapai, keluar dari voice channel.`);
      await this.sendChannelEmbed(
        buildInfoEmbed(
          'Keluar Otomatis (Tidak Ada Aktivitas)',
          'Tidak ada pemutaran musik baru selama beberapa menit. LaguKan keluar dari voice channel secara otomatis.'
        )
      );
      await this.manager.destroy(this.guildId);
    }, config.music.idleTimeoutMs);

    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  startEmptyChannelTimer() {
    if (this.emptyChannelTimer || this.twentyFourSeven) return;

    this.emptyChannelTimer = setTimeout(async () => {
      this.emptyChannelTimer = null;
      if (this.destroyed || this.twentyFourSeven) return;
      logger.info(`[Guild ${this.guildId}] Voice channel kosong, menghentikan musik & keluar otomatis.`);
      await this.sendChannelEmbed(
        buildInfoEmbed(
          'Voice Channel Kosong',
          'Semua pendengar telah meninggalkan voice channel. LaguKan menghentikan pemutaran dan keluar otomatis.'
        )
      );
      await this.manager.destroy(this.guildId);
    }, config.music.idleTimeoutMs);

    if (typeof this.emptyChannelTimer.unref === 'function') {
      this.emptyChannelTimer.unref();
    }
  }

  clearEmptyChannelTimer() {
    if (this.emptyChannelTimer) {
      clearTimeout(this.emptyChannelTimer);
      this.emptyChannelTimer = null;
    }
  }

  async disableOldPlayerMessage() {
    if (!this.playerMessage) return;
    const oldMsg = this.playerMessage;
    this.playerMessage = null;
    try {
      await oldMsg.edit({ components: [] });
    } catch {
      // Pesan mungkin sudah dihapus oleh moderator/pengguna
    }
  }

  async sendFreshPlayerMessage() {
    // JANGAN PERNAH mengirim panel Now Playing sebelum track & transport suara benar-benar aktif!
    if (!this.currentTrack || !this.trackStarted) return null;

    await this.disableOldPlayerMessage();
    const channel = await this.getTextChannel();
    if (!channel || typeof channel.send !== 'function') return null;

    try {
      const payload = buildMusicPlayerPayload(this);
      this.playerMessage = await channel.send(payload);
      return this.playerMessage;
    } catch (err) {
      logger.warn(`Gagal mengirim pesan Music Player di guild ${this.guildId}: ${err.message}`);
      return null;
    }
  }

  async updatePlayerMessage(options = {}) {
    if (this.updatingMessage) return;
    this.updatingMessage = true;
    try {
      if (!this.playerMessage) {
        if (!options.ended && this.currentTrack && this.trackStarted) {
          await this.sendFreshPlayerMessage();
        }
        return;
      }

      const payload = buildMusicPlayerPayload(this, options);
      await this.playerMessage.edit(payload);
      if (options.ended) {
        this.playerMessage = null;
      }
    } catch (err) {
      // Jika pesan dihapus (Unknown Message 10008), reset referensi
      if (err?.code === 10008) {
        this.playerMessage = null;
      } else {
        logger.debug(`Gagal memperbarui pesan Music Player: ${err.message}`);
      }
    } finally {
      this.updatingMessage = false;
    }
  }

  /**
   * Memulai pemutaran satu lagu spesifik pada Lavalink.
   * Mendukung mode waitForStart agar perintah /play menunggu konfirmasi nyata TrackStartEvent
   * DAN verifikasi koneksi UDP voice transport sebelum menyatakan musik aktif.
   */
  async playSpecificTrack(
    track,
    { startPositionMs = 0, waitForStart = false, preserveWaiters = false } = {}
  ) {
    if (this.destroyed || !track) {
      return { started: false, cancelled: true };
    }
    this.clearIdleTimer();

    const resolvedTrack = await this.client.sourceResolver.ensureTrackResolved(
      this.player.node,
      track
    );

    if (!resolvedTrack?.encoded) {
      throw new AppError(
        ErrorCodes.TRACK_PLAYBACK_FAILED,
        `Gagal memuat stream audio untuk **${track.info?.title || 'lagu'}**.`
      );
    }

    // Pastikan koneksi voice Discord tidak dalam keadaan self-mute
    const conn = this.client.shoukaku?.connections?.get(this.guildId);
    if (conn?.muted && typeof conn.setMute === 'function') {
      conn.setMute(false);
    }

    if (this.volume === 0) {
      logger.warn(
        `[PlayerState] ⚠️ Volume pemutar di guild=${this.guildId} bernilai 0%! Memulihkan ke ${config.music.defaultVolume}% agar audio terdengar.`
      );
      this.volume = config.music.defaultVolume;
    }

    // Jika node Lavalink terdeteksi berjalan pada Android Bionic tanpa decoder JNI glibc,
    // pastikan volume dikunci ke 100% dan filter dinonaktifkan agar Pure-Java Opus Passthrough bekerja.
    const nodeName = this.player?.node?.name;
    if (this.client.audioDiagnostics?.isNativeDecoderBroken(nodeName)) {
      if (this.volume !== config.music.opusPassthroughVolume) {
        this.volume = config.music.opusPassthroughVolume;
      }
      if (this.activeFilterKey !== 'off') {
        this.activeFilterKey = 'off';
        this.activeFilterLabel = 'Normal';
        await this.player.clearFilters().catch(() => {});
      }
    }

    this.currentTrack = resolvedTrack;
    this.paused = false;
    this.playing = true;
    this.trackStarted = false;
    this.audioPacketsSent = false;
    this._lastVoiceCloseCode = null;
    this._setState(
      resolvedTrack.fallbackFrom ? 'FALLBACK' : 'LOADING',
      `memuat "${resolvedTrack.info?.title || 'track'}"`
    );
    this.lastException = null;
    this.lastPosition = startPositionMs;
    this.lastPositionTimestamp = Date.now();

    // Jika sesi ini sudah berada pada mode Direct DAVE Voice (akibat Lavalink terkena Close 4017 pada Bionic),
    // putar langsung melalui DirectDaveVoiceSession tanpa kembali ke Koe yang rusak!
    if (this.usingDirectDaveVoice && this.directVoiceSession) {
      const directOk = await this._tryDirectDaveVoiceFallback(resolvedTrack);
      if (directOk) {
        return {
          started: true,
          track: this.currentTrack,
          usedFallback: Boolean(this.currentTrack?.fallbackFrom),
          usedDirectDave: true
        };
      }
      this.currentTrack = null;
      this.playing = false;
      this.trackStarted = false;
      this._setState('IDLE', 'direct dave stream gagal');
      const err = new AppError(
        ErrorCodes.TRACK_PLAYBACK_FAILED,
        `Gagal memuat stream langsung untuk **${resolvedTrack.info?.title || 'lagu'}** pada mode Direct DAVE Voice. Jalankan Lavalink melalui \`./scripts/start-lavalink-termux.sh\` untuk dukungan penuh semua sumber.`
      );
      this._resolvePendingStartWaiters({ started: false, error: err });
      throw err;
    }

    if (this.client.audioDiagnostics) {
      this.client.audioDiagnostics.recordStage(
        this.guildId,
        7,
        'Memuat & Mendekode Stream Audio di Lavalink',
        `judul="${resolvedTrack.info.title}", sumber=${resolvedTrack.info.sourceName}, vol=${this.volume}%, filter=${this.activeFilterKey}`
      );
    }

    let startPromise = null;
    if (waitForStart && !preserveWaiters) {
      startPromise = this._registerStartWaiter(config.music.trackStartTimeoutMs);
    }

    const playPayload = {
      track: { encoded: resolvedTrack.encoded },
      volume: this.volume,
      paused: false
    };
    if (startPositionMs > 0) {
      playPayload.position = startPositionMs;
    }

    try {
      await this.player.playTrack(playPayload);
    } catch (err) {
      if (this.client.audioDiagnostics) {
        this.client.audioDiagnostics.recordTrackError({
          guildId: this.guildId,
          nodeName,
          track: resolvedTrack,
          stage: 'PLAY_REST',
          rawException: err
        });
      }
      this.currentTrack = null;
      this.playing = false;
      this.trackStarted = false;
      this._setState('IDLE', 'playTrack gagal');
      this._resolvePendingStartWaiters({ started: false, error: err });
      throw err;
    }

    // Pra-muat lagu berikutnya di latar belakang jika berupa lagu deferred (misal dari album Spotify)
    const upcoming = this.queue.peek();
    if (upcoming && upcoming.unresolved && this.player?.node) {
      this.client.sourceResolver
        .ensureTrackResolved(this.player.node, upcoming)
        .then((resolvedNext) => {
          if (resolvedNext && this.queue.tracks[0] === upcoming) {
            this.queue.tracks[0] = resolvedNext;
          }
        })
        .catch(() => {});
    }

    // Untuk stub sinkron di unit test tanpa sesi WebSocket Lavalink nyata
    if (!this.isAsyncLavalinkSession()) {
      this.trackStarted = true;
      this._setState('PLAYING', 'stub sinkron unit test');
      this._resolvePendingStartWaiters({
        started: true,
        track: this.currentTrack,
        usedFallback: Boolean(this.currentTrack?.fallbackFrom)
      });
    }

    if (startPromise) {
      return await startPromise;
    }

    return {
      started: this.trackStarted,
      track: this.currentTrack,
      usedFallback: Boolean(this.currentTrack?.fallbackFrom)
    };
  }

  /**
   * Memulai pemutaran jika belum ada lagu yang sedang berjalan.
   */
  async playIfIdle({ waitForStart = false } = {}) {
    if (this.playing && this.currentTrack) {
      await this.updatePlayerMessage();
      if (waitForStart) {
        return {
          alreadyPlaying: true,
          started: this.trackStarted,
          track: this.currentTrack
        };
      }
      return false;
    }

    const next = this.queue.dequeueNext(null);
    if (!next) {
      return waitForStart ? { started: false, empty: true } : false;
    }

    const res = await this.playSpecificTrack(next, { waitForStart });
    return waitForStart ? res : true;
  }

  /**
   * Melanjutkan ke lagu berikutnya dalam antrean (atau Autoplay, atau berhenti rapi).
   */
  async advanceQueue({ skipped = false } = {}) {
    const finished = this.currentTrack;
    let nextTrack = this.queue.dequeueNext(finished, { skipped });

    if (!nextTrack && this.autoplay && finished && this.player?.node) {
      nextTrack = await findAutoplayTrack(this.player.node, finished, this.queue.history);
      if (nextTrack) {
        logger.info(`[Guild ${this.guildId}] Autoplay memilih: ${nextTrack.info.title}`);
      }
    }

    if (!nextTrack) {
      this.currentTrack = null;
      this.playing = false;
      this.paused = false;
      this.trackStarted = false;
      this._setState('IDLE', 'antrean selesai');
      this.lastPosition = 0;
      this.lastPositionTimestamp = 0;
      this.stopRefreshLoop();

      if (skipped && this.usingDirectDaveVoice && this.directVoiceSession) {
        this.directVoiceSession.stopTrack();
      } else if (skipped && this.player?.track) {
        this.suppressEndHandling = true;
        await this.player.stopTrack().catch(() => {});
      }

      await this.updatePlayerMessage({ ended: true });
      this.startIdleTimer();
      return null;
    }

    try {
      await this.playSpecificTrack(nextTrack);
      return this.currentTrack;
    } catch (err) {
      logger.warn(`[Guild ${this.guildId}] Gagal memutar lagu berikutnya (${nextTrack.info?.title}): ${err.message}`);
      this.consecutiveFailures += 1;
      await this.sendChannelEmbed(
        buildErrorEmbed(
          'Melewati Lagu yang Gagal Dimuat',
          `Tidak dapat memutar **${nextTrack.info?.title || 'lagu'}**. Mencoba lagu berikutnya...`
        )
      );
      if (this.consecutiveFailures < 3 && !this.queue.isEmpty) {
        return this.advanceQueue({ skipped: true });
      }
      this.currentTrack = null;
      this.playing = false;
      this.trackStarted = false;
      this._setState('IDLE', 'batas kegagalan beruntun tercapai');
      this.stopRefreshLoop();
      await this.updatePlayerMessage({ ended: true });
      this.startIdleTimer();
      return null;
    }
  }

  /**
   * Menjalankan jembatan suara terenkripsi penuh @discordjs/voice + @snazzah/davey (DAVE Protocol v1)
   * ketika Lavalink mengalami kegagalan libdave-jvm (Close 4017) pada Android Bionic.
   */
  async _tryDirectDaveVoiceFallback(trackToPlay) {
    if (!config.music.enableDirectDaveFallback || this.destroyed || !trackToPlay) {
      return false;
    }

    const guild = this.client.guilds?.cache?.get(this.guildId);
    if (!guild || typeof guild.voiceAdapterCreator !== 'function') {
      return false;
    }

    try {
      if (!this.directVoiceSession || this.directVoiceSession.destroyed) {
        this.directVoiceSession = new DirectDaveVoiceSession({
          guild,
          voiceChannelId: this.voiceChannelId,
          client: this.client,
          allowLoopback: Boolean(this._allowLoopbackDirectVoice),
          onTrackEnd: (ev) => {
            this.onTrackEnd(ev).catch((err) =>
              logger.error('Error pada DirectDaveVoice onTrackEnd', err)
            );
          },
          onTrackError: (err) => {
            logger.warn(`[DirectDaveVoice][Guild ${this.guildId}] Stream error: ${err.message}`);
            this.onTrackEnd({ reason: 'loadFailed' }).catch(() => {});
          }
        });
      }

      const directRes = await this.directVoiceSession.playTrack(trackToPlay, {
        volume: this.volume
      });

      if (directRes?.started) {
        this.usingDirectDaveVoice = true;
        this.consecutiveFailures = 0;
        this.playing = true;
        this.paused = false;
        this.trackStarted = true;
        this.voiceConnected = true;
        this.audioPacketsSent = true;
        this.voicePingMs = typeof directRes.ping === 'number' ? directRes.ping : 0;
        this.lastPosition = 0;
        this.lastPositionTimestamp = Date.now();
        this._setState(
          'PLAYING',
          `Direct DAVE E2EE v1 aktif (${directRes.container}, packets=${directRes.packetsSent})`
        );

        if (this.client.audioDiagnostics) {
          this.client.audioDiagnostics.recordStage(
            this.guildId,
            8,
            'Transmisi Audio Direct DAVE E2EE v1 (@snazzah/davey) Aktif',
            `judul="${trackToPlay.info?.title}", container=${directRes.container}, packets=${directRes.packetsSent}`
          );
          this.client.audioDiagnostics.recordStage(
            this.guildId,
            9,
            'Panel Now Playing Aktif Ditampilkan',
            `judul="${trackToPlay.info?.title}" [Direct DAVE v1]`
          );
        }

        this._resolvePendingStartWaiters({
          started: true,
          track: this.currentTrack,
          usedFallback: true,
          usedDirectDave: true
        });

        await this.sendFreshPlayerMessage();
        this.startRefreshLoop();
        return true;
      }
    } catch (err) {
      logger.warn(
        `[DirectDaveVoice][Guild ${this.guildId}] Fallback Direct DAVE tidak dapat memutar "${
          trackToPlay.info?.title || 'lagu'
        }": ${err.message}`
      );
    }

    return false;
  }

  async onTrackStart() {
    const trackAtStart = this.currentTrack;
    const title = trackAtStart?.info?.title || 'Lagu';
    const source = trackAtStart?.info?.sourceName || 'audio';

    logger.info(
      `[TrackStart] 🎵 Track playback started: guild=${this.guildId}, title="${title}", source=${source}, volume=${this.volume}%`
    );

    if (this.hasLiveVoiceTransportCheck()) {
      this._setState('VERIFYING_VOICE', 'verifikasi koneksi UDP & paket suara Discord');
    }

    const voiceCheck = await this._verifyVoiceTransportReady();
    if (!voiceCheck.ok) {
      if (voiceCheck.cancelled || this.destroyed) return;

      logger.error(
        `[VoiceUDP] ❌ Kegagalan koneksi suara Discord pada Lavalink: "${title}" state.connected=false (closeCode=${
          voiceCheck.closeCode || this._lastVoiceCloseCode || 'none'
        })!`
      );

      // Hentikan stream bisu di Lavalink terlebih dahulu
      if (this.player) {
        this.suppressEndHandling = true;
        await this.player.stopTrack().catch(() => {});
      }

      const isClose4017 =
        voiceCheck.closeCode === 4017 || this._lastVoiceCloseCode === 4017;

      // Coba jembatan suara Direct DAVE E2EE v1 (@discordjs/voice + @snazzah/davey ARM64)
      // apabila track memiliki stream langsung yang sah & guild adapter tersedia!
      const recoveredViaDirectDave = await this._tryDirectDaveVoiceFallback(trackAtStart);
      if (recoveredViaDirectDave) {
        return;
      }

      const rawVoiceReason = isClose4017
        ? 'Discord Voice Close 4017 (DAVE protocol required — libdave-jvm missing on Bionic)'
        : 'VOICE_TRANSPORT_NOT_CONNECTED: UDP/Discord Voice transport failed (state.connected=false)';

      const diagnosis = this.client.audioDiagnostics
        ? this.client.audioDiagnostics.recordTrackError({
            guildId: this.guildId,
            nodeName: this.player?.node?.name,
            track: trackAtStart,
            stage: 'VOICE_UDP_TRANSPORT',
            rawException: rawVoiceReason
          })
        : null;

      this.playing = false;
      this.trackStarted = false;
      this.currentTrack = null;
      this._setState('VOICE_ERROR', 'state.connected=false (0 paket audio terkirim)');
      this.stopRefreshLoop();

      const hadWaiter = this._pendingStartWaiters.length > 0;
      this._resolvePendingStartWaiters({
        started: false,
        failedTrack: trackAtStart,
        diagnosis
      });

      if (!hadWaiter && diagnosis?.userMessage) {
        await this.sendChannelEmbed(
          buildErrorEmbed('Koneksi Suara UDP / DAVE Discord Gagal', diagnosis.userMessage)
        );
      }

      this.startIdleTimer();
      return;
    }

    // Jika YouTube berhasil diputar penuh sampai ke voice Discord, bersihkan status circuit-breaker YouTube!
    if (/^youtube/i.test(source) && this.client.audioDiagnostics) {
      this.client.audioDiagnostics.clearYoutubeDegraded(this.player?.node?.name);
    }

    this.consecutiveFailures = 0;
    this.playing = true;
    this.paused = false;
    this.trackStarted = true;
    this._setState('PLAYING', 'audio aktif terkirim ke Discord Voice Channel');
    this.lastPositionTimestamp = Date.now();

    if (this.client.audioDiagnostics) {
      this.client.audioDiagnostics.recordStage(
        this.guildId,
        8,
        'Transmisi Audio ke Discord Voice Gateway Aktif',
        `judul="${title}", udpConnected=${this.voiceConnected}, ping=${this.voicePingMs}ms`
      );
      this.client.audioDiagnostics.recordStage(
        this.guildId,
        9,
        'Panel Now Playing Aktif Ditampilkan',
        `judul="${title}" [${source}]`
      );
    }

    this._resolvePendingStartWaiters({
      started: true,
      track: this.currentTrack,
      usedFallback: Boolean(this.currentTrack?.fallbackFrom)
    });

    await this.sendFreshPlayerMessage();
    this.startRefreshLoop();
  }

  async onTrackEnd(event) {
    const reason = event?.reason;

    if (this.suppressEndHandling) {
      this.suppressEndHandling = false;
      return;
    }

    // Jika digantikan oleh playTrack baru atau cleanup, jangan majukan antrean dua kali
    if (reason === 'replaced' || reason === 'cleanup') {
      return;
    }

    if (reason === 'stopped') {
      return;
    }

    if (reason === 'loadFailed') {
      const failedTrack = this.currentTrack;
      const lastExc = this.lastException;

      // 1. Self-Healing Retry: jika gagal semata karena volume != 100 atau filter memicu JNI OpusDecoder
      //    pada Android Bionic, coba ulangi track yang sama 1x pada Volume 100% (Pure-Java Opus Passthrough)
      if (
        failedTrack &&
        !failedTrack._retriedAtSafeVolume &&
        lastExc?.diagnosis?.code === 'ANDROID_JNI_DECODER_UNSUPPORTED' &&
        lastExc.hadNonPassthroughSettings &&
        this.player?.node
      ) {
        failedTrack._retriedAtSafeVolume = true;
        logger.info(
          `[Self-Heal][Guild ${this.guildId}] Mengulangi "${failedTrack.info?.title}" pada Volume 100% tanpa filter (Pure-Java Opus Passthrough).`
        );
        try {
          await this.playSpecificTrack(failedTrack, { preserveWaiters: true });
          return;
        } catch (retryErr) {
          logger.warn(`[Self-Heal][Guild ${this.guildId}] Percobaan ulang safe-volume gagal: ${retryErr.message}`);
        }
      }

      // 2. Bounded Multi-Source Fallback (YouTube/YTMusic -> SoundCloud Ogg Opus -> alternatif non-live)
      if (failedTrack && this.player?.node) {
        let fallbackTrack = null;
        if (typeof this.client.sourceResolver?.findFallbackTrack === 'function') {
          fallbackTrack = await this.client.sourceResolver.findFallbackTrack(
            this.player.node,
            failedTrack
          );
        } else if (
          !failedTrack._retriedViaSoundCloud &&
          typeof this.client.sourceResolver?.findSoundCloudFallback === 'function'
        ) {
          fallbackTrack = await this.client.sourceResolver.findSoundCloudFallback(
            this.player.node,
            failedTrack
          );
        }

        if (fallbackTrack?.encoded) {
          logger.info(
            `[Fallback][Guild ${this.guildId}] Mengalihkan "${failedTrack.info?.title}" (${failedTrack.info?.sourceName}) -> "${fallbackTrack.info?.title}" (${fallbackTrack.info?.sourceName}).`
          );
          try {
            await this.playSpecificTrack(fallbackTrack, { preserveWaiters: true });
            return;
          } catch (fbErr) {
            logger.warn(`[Fallback][Guild ${this.guildId}] Gagal memulai track fallback: ${fbErr.message}`);
          }
        }
      }

      // 3. Seluruh sumber untuk lagu ini gagal — JANGAN kirim Now Playing palsu & JANGAN loop tak terbatas
      const diagnosis =
        lastExc?.diagnosis ||
        (this.client.audioDiagnostics
          ? this.client.audioDiagnostics.recordTrackError({
              guildId: this.guildId,
              nodeName: this.player?.node?.name,
              track: failedTrack,
              stage: 'LOAD_FAILED',
              rawException: 'Track ended with reason: loadFailed'
            })
          : null);

      this.consecutiveFailures += 1;
      const failedTitle = failedTrack?.info?.title || 'Lagu';
      const detailedReason =
        diagnosis?.userMessage ||
        `Sumber audio untuk **${failedTitle}** gagal dimuat atau didekode oleh server Lavalink.`;

      logger.warn(`[Guild ${this.guildId}] Track loadFailed setelah fallback: ${failedTitle} (${diagnosis?.code || 'UNKNOWN'})`);

      const hadInteractiveWaiter = this._pendingStartWaiters.length > 0;
      this._resolvePendingStartWaiters({
        started: false,
        failedTrack,
        diagnosis
      });

      if (!hadInteractiveWaiter) {
        await this.sendChannelEmbed(
          buildErrorEmbed(
            'Pemutaran Lagu Gagal',
            `**${failedTitle}** tidak dapat diputar.\n${detailedReason}`
          )
        );
      }

      if (this.consecutiveFailures >= 3 || this.queue.isEmpty) {
        this.currentTrack = null;
        this.playing = false;
        this.trackStarted = false;
        this._setState('IDLE', 'gagal memuat lagu');
        this.stopRefreshLoop();
        await this.updatePlayerMessage({ ended: true });
        this.startIdleTimer();
        return;
      }

      await this.advanceQueue({ skipped: true });
      return;
    }

    // reason === 'finished'
    await this.advanceQueue({ skipped: false });
  }

  async onTrackException(event) {
    const rawExc = event?.exception || event;
    const hadNonPassthroughSettings =
      this.volume !== config.music.opusPassthroughVolume || this.activeFilterKey !== 'off';

    let diagnosis = null;
    if (this.client.audioDiagnostics) {
      diagnosis = this.client.audioDiagnostics.recordTrackError({
        guildId: this.guildId,
        nodeName: this.player?.node?.name,
        track: this.currentTrack,
        stage: 'DECODE_EXCEPTION',
        rawException: rawExc
      });
    }

    this.lastException = {
      diagnosis,
      raw: rawExc,
      hadNonPassthroughSettings,
      at: Date.now()
    };

    const msg = rawExc?.message || rawExc?.cause || 'Kesalahan dekode audio';
    const severity = rawExc?.severity || 'COMMON';
    logger.warn(
      `[TrackException] ❌ Track exception: guild=${this.guildId}, track="${
        this.currentTrack?.info?.title || 'unknown'
      }", severity=${severity}, code=${diagnosis?.code || 'ERROR'}, message=${msg}${
        rawExc?.cause ? ` | Cause: ${rawExc.cause}` : ''
      }`
    );

    // Self-heal otomatis untuk lingkungan Android Termux Bionic tanpa decoder JNI glibc
    if (diagnosis?.isNativeJniFailure && hadNonPassthroughSettings) {
      this.volume = config.music.opusPassthroughVolume;
      this.activeFilterKey = 'off';
      this.activeFilterLabel = 'Normal';
      await this.player.clearFilters().catch(() => {});
      await this.player.setGlobalVolume(config.music.opusPassthroughVolume).catch(() => {});
    }
  }

  async onTrackStuck(event) {
    const threshold = event?.thresholdMs || 10000;
    const stuckTrack = this.currentTrack;
    logger.warn(
      `[TrackStuck] ⚠️ Track stuck: guild=${this.guildId}, track="${
        stuckTrack?.info?.title || 'unknown'
      }", thresholdMs=${threshold}ms`
    );
    if (this.client.audioDiagnostics) {
      this.client.audioDiagnostics.recordTrackError({
        guildId: this.guildId,
        nodeName: this.player?.node?.name,
        track: stuckTrack,
        stage: 'TRACK_STUCK',
        rawException: `Audio stream stuck > ${threshold}ms`
      });
    }

    // Coba alihkan lagu yang macet ke sumber alternatif (SoundCloud / Bandcamp) sebelum melewati lagu!
    if (
      stuckTrack &&
      this.player?.node &&
      typeof this.client.sourceResolver?.findFallbackTrack === 'function'
    ) {
      const fallbackTrack = await this.client.sourceResolver
        .findFallbackTrack(this.player.node, stuckTrack)
        .catch(() => null);
      if (fallbackTrack?.encoded) {
        logger.info(
          `[TrackStuck][Guild ${this.guildId}] Memulihkan stream macet "${stuckTrack.info?.title}" -> sumber alternatif "${fallbackTrack.info?.sourceName}".`
        );
        try {
          if (this.player?.track) {
            this.suppressEndHandling = true;
            await this.player.stopTrack().catch(() => {});
          }
          await this.playSpecificTrack(fallbackTrack, { preserveWaiters: true });
          return;
        } catch (fbErr) {
          logger.warn(`[TrackStuck][Guild ${this.guildId}] Pemulihan fallback gagal: ${fbErr.message}`);
        }
      }
    }

    await this.sendChannelEmbed(
      buildErrorEmbed(
        'Aliran Audio Macet (Stuck)',
        `Aliran audio terhenti lebih dari ${threshold / 1000} detik. Beralih ke lagu berikutnya...`
      )
    );
    await this.advanceQueue({ skipped: true });
  }

  async onWebSocketClosed(event) {
    const code = event?.code;
    const reason = event?.reason || 'unknown';
    this.voiceConnected = false;
    this._lastVoiceCloseCode = code || null;
    logger.warn(
      `[VoiceState] Voice WebSocket closed: guild=${this.guildId}, code=${code}, reason=${reason}`
    );

    if (code === 4017 && this.client.audioDiagnostics) {
      this.client.audioDiagnostics.recordTrackError({
        guildId: this.guildId,
        nodeName: this.player?.node?.name,
        track: this.currentTrack,
        stage: 'VOICE_GATEWAY_DAVE',
        rawException: `Discord Voice Close 4017 (DAVE E2EE libdave-jvm): ${reason}`
      });
    }

    // Code 4014 = Disconnected / Channel deleted / Kicked
    if (code === 4014 && !this.twentyFourSeven) {
      await this.manager.destroy(this.guildId, { skipLeave: true });
    }
  }

  // ================== KONTROL PEMUTAR ==================

  async pause() {
    if (!this.currentTrack || !this.playing) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Tidak ada lagu yang sedang diputar saat ini.', {
        isWarning: true
      });
    }
    if (this.paused) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Musik sudah dalam keadaan dijeda.', {
        isWarning: true
      });
    }

    this.lastPosition = this.getCurrentPosition();
    this.lastPositionTimestamp = Date.now();
    if (this.usingDirectDaveVoice && this.directVoiceSession) {
      this.directVoiceSession.setPaused(true);
    } else {
      await this.player.setPaused(true);
    }
    this.paused = true;
    this._setState('PAUSED', 'dijeda pengguna');
    await this.updatePlayerMessage();
  }

  async resume() {
    if (!this.currentTrack) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Tidak ada lagu untuk dilanjutkan.', {
        isWarning: true
      });
    }
    if (!this.paused) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Musik sedang berjalan dan tidak dijeda.', {
        isWarning: true
      });
    }

    this.lastPositionTimestamp = Date.now();
    if (this.usingDirectDaveVoice && this.directVoiceSession) {
      this.directVoiceSession.setPaused(false);
    } else {
      await this.player.setPaused(false);
    }
    this.paused = false;
    this._setState(this.trackStarted ? 'PLAYING' : 'LOADING', 'dilanjutkan pengguna');
    await this.updatePlayerMessage();
  }

  async skip() {
    if (!this.currentTrack) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Tidak ada lagu yang sedang diputar untuk dilewati.', {
        isWarning: true
      });
    }
    const skippedTrack = this.currentTrack;
    const nextTrack = await this.advanceQueue({ skipped: true });
    return { skippedTrack, nextTrack };
  }

  async previous() {
    const prevTrack = this.queue.popPrevious(this.currentTrack);
    if (!prevTrack) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        'Belum ada riwayat lagu sebelumnya pada sesi ini.',
        { isWarning: true }
      );
    }
    await this.playSpecificTrack(prevTrack);
    return this.currentTrack;
  }

  async seek(positionMs) {
    if (!this.currentTrack) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Tidak ada lagu yang sedang diputar.', {
        isWarning: true
      });
    }
    if (this.currentTrack.info?.isStream || !this.currentTrack.info?.isSeekable) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Siaran langsung (LIVE) atau sumber ini tidak mendukung fitur seek.',
        { isWarning: true }
      );
    }

    const duration = Number(this.currentTrack.info.length || 0);
    if (positionMs < 0 || (duration > 0 && positionMs > duration)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Posisi waktu melebihi durasi lagu saat ini.',
        { isWarning: true }
      );
    }

    await this.player.seekTo(positionMs);
    this.lastPosition = positionMs;
    this.lastPositionTimestamp = Date.now();
    await this.updatePlayerMessage();
  }

  async replay() {
    if (!this.currentTrack) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Tidak ada lagu yang sedang diputar.', {
        isWarning: true
      });
    }
    if (!this.currentTrack.info?.isStream && this.currentTrack.info?.isSeekable) {
      await this.seek(0);
    } else {
      await this.playSpecificTrack(this.currentTrack);
    }
    return this.currentTrack;
  }

  async setVolume(newVolume) {
    const nodeName = this.player?.node?.name;
    if (
      this.client.audioDiagnostics?.isNativeDecoderBroken(nodeName) &&
      Math.round(Number(newVolume)) !== config.music.opusPassthroughVolume
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Server Lavalink Anda saat ini berjalan di Android Bionic tanpa decoder native \`glibc\`, sehingga volume dikunci pada **100%** agar **Pure-Java Opus Passthrough** tetap mengeluarkan suara jernih. Untuk mengaktifkan pengatur volume bebas, jalankan Lavalink melalui \`./scripts/start-lavalink-termux.sh\`.`,
        { isWarning: true }
      );
    }

    const clamped = Math.max(
      config.music.minVolume,
      Math.min(config.music.maxVolume, Math.round(Number(newVolume)))
    );
    if (this.usingDirectDaveVoice && this.directVoiceSession) {
      this.directVoiceSession.setVolume(clamped);
    } else {
      await this.player.setGlobalVolume(clamped);
    }
    this.volume = clamped;
    await this.updatePlayerMessage();
    return this.volume;
  }

  async setFilter(presetKey) {
    const preset = getFilterPreset(presetKey);
    if (!preset) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Preset filter audio tidak dikenali.', {
        isWarning: true
      });
    }

    const nodeName = this.player?.node?.name;
    if (
      preset.key !== 'off' &&
      this.client.audioDiagnostics?.isNativeDecoderBroken(nodeName)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Efek filter DSP membutuhkan decoder native \`glibc\` (\`libconnector.so\`). Saat ini Lavalink berjalan dalam mode **Pure-Java Opus Passthrough** di Android Bionic. Jalankan Lavalink menggunakan \`./scripts/start-lavalink-termux.sh\` untuk mengaktifkan filter audio.`,
        { isWarning: true }
      );
    }

    this.lastPosition = this.getCurrentPosition();
    this.lastPositionTimestamp = Date.now();

    if (preset.key === 'off') {
      await this.player.clearFilters();
    } else {
      await this.player.setFilters(preset.payload);
    }

    this.activeFilterKey = preset.key;
    this.activeFilterLabel = preset.label;
    await this.updatePlayerMessage();
    return preset;
  }

  async stop({ keepConnectionIf247 = true } = {}) {
    this.queue.resetAll();
    const hadTrack = Boolean(this.currentTrack);
    this.currentTrack = null;
    this.playing = false;
    this.paused = false;
    this.trackStarted = false;
    this.audioPacketsSent = false;
    this._setState('STOPPED', 'dihentikan pengguna');
    this.lastPosition = 0;
    this.lastPositionTimestamp = 0;
    this.stopRefreshLoop();
    this._resolvePendingStartWaiters({ started: false, cancelled: true });

    if (this.directVoiceSession) {
      this.directVoiceSession.stopTrack();
    }
    if (hadTrack && this.player && !this.usingDirectDaveVoice) {
      this.suppressEndHandling = true;
      await this.player.stopTrack().catch(() => {});
    }

    await this.updatePlayerMessage({ ended: true });

    if (!keepConnectionIf247 || !this.twentyFourSeven) {
      await this.manager.destroy(this.guildId);
      return { stayedInChannel: false };
    }

    this._setState('IDLE', 'mode 24/7 tetap di channel');
    return { stayedInChannel: true };
  }

  cleanupTimersAndListeners() {
    this.destroyed = true;
    this.voiceConnected = false;
    this.audioPacketsSent = false;
    this._setState('DESTROYED', 'sesi dibersihkan');
    this.stopRefreshLoop();
    this.clearIdleTimer();
    this.clearEmptyChannelTimer();
    this._resolvePendingStartWaiters({ started: false, cancelled: true });
    if (this.directVoiceSession) {
      this.directVoiceSession.destroy();
      this.directVoiceSession = null;
    }
    this.usingDirectDaveVoice = false;
    if (this.player) {
      this.player.removeAllListeners();
    }
  }
}

module.exports = {
  MusicPlayer
};
