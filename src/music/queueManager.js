'use strict';

const { config } = require('../../config/config');
const { AppError, ErrorCodes } = require('../utils/errorHandler');

class QueueManager {
  constructor(guildId, options = {}) {
    this.guildId = String(guildId);
    this.maxSize = options.maxSize || config.music.maxQueueSize;
    this.maxHistorySize = options.maxHistorySize || config.music.maxHistorySize;
    this.tracks = [];
    this.history = [];
    /** @type {'off' | 'track' | 'queue'} */
    this.loopMode = 'off';
  }

  get size() {
    return this.tracks.length;
  }

  get isEmpty() {
    return this.tracks.length === 0;
  }

  peek() {
    return this.tracks[0] || null;
  }

  getAt(position1Based) {
    const idx = Number(position1Based) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.tracks.length) {
      return null;
    }
    return this.tracks[idx];
  }

  enqueue(track, { unshift = false } = {}) {
    if (!track) return 0;
    if (this.tracks.length >= this.maxSize) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Antrean server ini sudah penuh (maksimum **${this.maxSize}** lagu).`,
        { isWarning: true }
      );
    }

    if (unshift) {
      this.tracks.unshift(track);
      return 1;
    }

    this.tracks.push(track);
    return this.tracks.length;
  }

  enqueueMany(trackList = []) {
    if (!Array.isArray(trackList) || trackList.length === 0) return [];
    const remainingSlots = Math.max(0, this.maxSize - this.tracks.length);
    if (remainingSlots === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Antrean server ini sudah penuh (maksimum **${this.maxSize}** lagu).`,
        { isWarning: true }
      );
    }

    const toAdd = trackList.slice(0, remainingSlots);
    this.tracks.push(...toAdd);
    return toAdd;
  }

  pushHistory(track) {
    if (!track) return;
    const last = this.history[this.history.length - 1];
    if (last && last.info?.identifier && last.info.identifier === track.info?.identifier) {
      return;
    }
    this.history.push(track);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  /**
   * Mengambil lagu berikutnya berdasarkan mode loop saat ini.
   * @param {object|null} finishedTrack Lagu yang baru saja selesai
   * @param {{ skipped?: boolean }} options Jika di-skip manual, loop 'track' tetap maju ke lagu berikutnya
   */
  dequeueNext(finishedTrack = null, { skipped = false } = {}) {
    if (finishedTrack) {
      if (this.loopMode === 'track' && !skipped) {
        return finishedTrack;
      }
      this.pushHistory(finishedTrack);
      if (this.loopMode === 'queue') {
        this.tracks.push(finishedTrack);
      }
    }

    if (this.tracks.length === 0) {
      return null;
    }

    return this.tracks.shift();
  }

  /**
   * Mengambil lagu sebelumnya dari riwayat dan mengembalikan lagu aktif ke depan antrean.
   */
  popPrevious(currentTrack = null) {
    if (this.history.length === 0) {
      return null;
    }

    const previousTrack = this.history.pop();
    if (currentTrack && this.tracks.length < this.maxSize) {
      this.tracks.unshift(currentTrack);
    }
    return previousTrack;
  }

  /**
   * Mengacak antrean menggunakan algoritma Fisher-Yates.
   */
  shuffle() {
    if (this.tracks.length < 2) return this.tracks;
    for (let i = this.tracks.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = this.tracks[i];
      this.tracks[i] = this.tracks[j];
      this.tracks[j] = temp;
    }
    return this.tracks;
  }

  setLoopMode(mode) {
    if (!['off', 'track', 'queue'].includes(mode)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Mode loop tidak valid. Pilih `off`, `track`, atau `queue`.',
        { isWarning: true }
      );
    }
    this.loopMode = mode;
    return this.loopMode;
  }

  cycleLoopMode() {
    const order = ['off', 'track', 'queue'];
    const nextIdx = (order.indexOf(this.loopMode) + 1) % order.length;
    this.loopMode = order[nextIdx];
    return this.loopMode;
  }

  remove(position1Based) {
    const idx = Number(position1Based) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.tracks.length) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Posisi antrean **#${position1Based}** tidak valid. Terdapat **${this.tracks.length}** lagu dalam antrean.`,
        { isWarning: true }
      );
    }
    const [removed] = this.tracks.splice(idx, 1);
    return removed;
  }

  move(from1Based, to1Based) {
    const fromIdx = Number(from1Based) - 1;
    const toIdx = Number(to1Based) - 1;
    if (
      !Number.isInteger(fromIdx) ||
      !Number.isInteger(toIdx) ||
      fromIdx < 0 ||
      toIdx < 0 ||
      fromIdx >= this.tracks.length ||
      toIdx >= this.tracks.length
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Posisi pemindahan tidak valid. Masukkan angka antara **1** hingga **${this.tracks.length}**.`,
        { isWarning: true }
      );
    }
    if (fromIdx === toIdx) return this.tracks[fromIdx];

    const [item] = this.tracks.splice(fromIdx, 1);
    this.tracks.splice(toIdx, 0, item);
    return item;
  }

  /**
   * Melompat langsung ke lagu pada posisi tertentu.
   */
  jump(position1Based, discardSkipped = true) {
    const idx = Number(position1Based) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.tracks.length) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Posisi antrean **#${position1Based}** tidak valid. Terdapat **${this.tracks.length}** lagu dalam antrean.`,
        { isWarning: true }
      );
    }

    if (discardSkipped) {
      const skipped = this.tracks.splice(0, idx);
      for (const s of skipped) {
        this.pushHistory(s);
      }
      return this.tracks.shift();
    }

    const [target] = this.tracks.splice(idx, 1);
    return target;
  }

  clear() {
    const count = this.tracks.length;
    this.tracks = [];
    return count;
  }

  resetAll() {
    this.tracks = [];
    this.history = [];
    this.loopMode = 'off';
  }

  getAllTracksIncludingCurrent(currentTrack = null) {
    const list = [];
    if (currentTrack) list.push(currentTrack);
    list.push(...this.tracks);
    return list;
  }
}

module.exports = {
  QueueManager
};
