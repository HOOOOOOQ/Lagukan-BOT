'use strict';

const { QueueManager } = require('./queueManager');
const { getFilterPreset } = require('./filters');
const { findAutoplayTrack } = require('./autoplay');
const {
  buildMusicPlayerPayload,
  buildErrorEmbed,
  buildInfoEmbed
} = require('../utils/embeds');
const { AppError, ErrorCodes } = require('../utils/errorHandler');
const logger = require('../utils/logger').child('MusicPlayer');
const { config } = require('../../config/config');

class MusicPlayer {
  /**
   * @param {object} options
   * @param {import('../client')} options.client
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
    this.destroyed = false;

    this.volume = Number(guildSettings?.default_volume ?? config.music.defaultVolume);
    this.twentyFourSeven = Boolean(guildSettings?.twenty_four_seven);
    this.autoplay = Boolean(guildSettings?.autoplay);

    this.activeFilterKey = 'off';
    this.activeFilterLabel = 'Normal';

    this.lastPosition = 0;
    this.lastPositionTimestamp = 0;
    this.consecutiveFailures = 0;
    this.suppressEndHandling = false;

    /** @type {import('discord.js').Message | null} */
    this.playerMessage = null;
    this.refreshInterval = null;
    this.idleTimer = null;
    this.emptyChannelTimer = null;
    this.updatingMessage = false;

    this.bindPlayerEvents(this.player);
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
      if (data?.state) {
        this.lastPosition = Number(data.state.position || 0);
        this.lastPositionTimestamp = Date.now();
      }
    });

    shoukakuPlayer.on('resumed', () => {
      logger.info(`[Guild ${this.guildId}] Sesi pemutar musik berhasil dipulihkan oleh Shoukaku.`);
    });
  }

  attachNewShoukakuPlayer(newShoukakuPlayer) {
    this.player = newShoukakuPlayer;
    this.bindPlayerEvents(newShoukakuPlayer);
  }

  getCurrentPosition() {
    if (!this.currentTrack) return 0;
    if (this.paused || !this.lastPositionTimestamp) {
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
      if (this.destroyed || this.paused || !this.playing || !this.currentTrack) return;
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
        if (!options.ended && this.currentTrack) {
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
   */
  async playSpecificTrack(track, { startPositionMs = 0 } = {}) {
    if (this.destroyed || !track) return;
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

    this.currentTrack = resolvedTrack;
    this.paused = false;
    this.playing = true;
    this.lastPosition = startPositionMs;
    this.lastPositionTimestamp = Date.now();

    const playPayload = {
      track: { encoded: resolvedTrack.encoded },
      volume: this.volume,
      paused: false
    };
    if (startPositionMs > 0) {
      playPayload.position = startPositionMs;
    }

    await this.player.playTrack(playPayload);

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
  }

  /**
   * Memulai pemutaran jika belum ada lagu yang sedang berjalan.
   */
  async playIfIdle() {
    if (this.playing && this.currentTrack) {
      await this.updatePlayerMessage();
      return false;
    }

    const next = this.queue.dequeueNext(null);
    if (!next) return false;

    await this.playSpecificTrack(next);
    return true;
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
      this.lastPosition = 0;
      this.lastPositionTimestamp = 0;
      this.stopRefreshLoop();

      if (skipped && this.player?.track) {
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
      this.stopRefreshLoop();
      await this.updatePlayerMessage({ ended: true });
      this.startIdleTimer();
      return null;
    }
  }

  async onTrackStart() {
    this.consecutiveFailures = 0;
    this.playing = true;
    this.paused = false;
    this.lastPositionTimestamp = Date.now();
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
      this.consecutiveFailures += 1;
      const failedTitle = this.currentTrack?.info?.title || 'Lagu';
      logger.warn(`[Guild ${this.guildId}] Track loadFailed: ${failedTitle}`);
      await this.sendChannelEmbed(
        buildErrorEmbed(
          'Pemutaran Lagu Gagal',
          `Sumber audio untuk **${failedTitle}** gagal dimuat oleh Lavalink.`
        )
      );
      if (this.consecutiveFailures >= 3) {
        this.currentTrack = null;
        this.playing = false;
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
    const msg = event?.exception?.message || 'Kesalahan dekode audio';
    logger.warn(`[Guild ${this.guildId}] TrackException: ${msg}`);
  }

  async onTrackStuck(event) {
    logger.warn(`[Guild ${this.guildId}] TrackStuck (${event?.thresholdMs}ms), melewati otomatis.`);
    await this.sendChannelEmbed(
      buildErrorEmbed(
        'Aliran Audio Macet (Stuck)',
        `Aliran audio terhenti lebih dari ${(event?.thresholdMs || 10000) / 1000} detik. Beralih ke lagu berikutnya...`
      )
    );
    await this.advanceQueue({ skipped: true });
  }

  async onWebSocketClosed(event) {
    logger.warn(
      `[Guild ${this.guildId}] Voice WebSocket tertutup (code=${event?.code}, reason=${event?.reason || 'unknown'})`
    );
    // Code 4014 = Disconnected / Channel deleted / Kicked
    if (event?.code === 4014 && !this.twentyFourSeven) {
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
    await this.player.setPaused(true);
    this.paused = true;
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
    await this.player.setPaused(false);
    this.paused = false;
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
    const clamped = Math.max(
      config.music.minVolume,
      Math.min(config.music.maxVolume, Math.round(Number(newVolume)))
    );
    await this.player.setGlobalVolume(clamped);
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
    this.lastPosition = 0;
    this.lastPositionTimestamp = 0;
    this.stopRefreshLoop();

    if (hadTrack && this.player) {
      this.suppressEndHandling = true;
      await this.player.stopTrack().catch(() => {});
    }

    await this.updatePlayerMessage({ ended: true });

    if (!keepConnectionIf247 || !this.twentyFourSeven) {
      await this.manager.destroy(this.guildId);
      return { stayedInChannel: false };
    }

    return { stayedInChannel: true };
  }

  cleanupTimersAndListeners() {
    this.destroyed = true;
    this.stopRefreshLoop();
    this.clearIdleTimer();
    this.clearEmptyChannelTimer();
    if (this.player) {
      this.player.removeAllListeners();
    }
  }
}

module.exports = {
  MusicPlayer
};
