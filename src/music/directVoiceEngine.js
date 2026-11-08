'use strict';

const { PassThrough, Transform, Readable } = require('node:stream');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType
} = require('@discordjs/voice');
const davey = require('@snazzah/davey');
const { isPrivateOrLocalHost } = require('./sourceResolver');
const { inspectDaveSupport } = require('./audioDiagnostics');
const logger = require('../utils/logger').child('DirectDaveVoice');

/**
 * Mengonversi stream WAV PCM (16-bit LE) menjadi stream PCM 48kHz Stereo s16le murni di JavaScript
 * agar dapat dienkode oleh opusscript tanpa membutuhkan binary FFmpeg eksternal.
 */
class WavTo48kStereoPcmTransformer extends Transform {
  constructor() {
    super();
    this._headerBuf = Buffer.alloc(0);
    this._parsed = false;
    this._sampleRate = 48000;
    this._channels = 2;
    this._bitsPerSample = 16;
    this._leftover = Buffer.alloc(0);
  }

  _transform(chunk, _enc, cb) {
    try {
      if (!this._parsed) {
        this._headerBuf = Buffer.concat([this._headerBuf, chunk]);
        if (this._headerBuf.length < 44) {
          cb();
          return;
        }

        // Cari subchunk "fmt " dan "data"
        if (
          this._headerBuf.toString('ascii', 0, 4) !== 'RIFF' ||
          this._headerBuf.toString('ascii', 8, 12) !== 'WAVE'
        ) {
          cb(new Error('Header WAV tidak valid'));
          return;
        }

        let offset = 12;
        let dataStart = -1;
        while (offset + 8 <= this._headerBuf.length) {
          const id = this._headerBuf.toString('ascii', offset, offset + 4);
          const size = this._headerBuf.readUInt32LE(offset + 4);
          if (id === 'fmt ' && offset + 8 + 16 <= this._headerBuf.length) {
            this._channels = this._headerBuf.readUInt16LE(offset + 10);
            this._sampleRate = this._headerBuf.readUInt32LE(offset + 12);
            this._bitsPerSample = this._headerBuf.readUInt16LE(offset + 22);
          } else if (id === 'data') {
            dataStart = offset + 8;
            break;
          }
          offset += 8 + size + (size % 2);
        }

        if (dataStart === -1) {
          if (this._headerBuf.length > 8192) {
            cb(new Error('Chunk data WAV tidak ditemukan'));
          } else {
            cb();
          }
          return;
        }

        this._parsed = true;
        const body = this._headerBuf.subarray(dataStart);
        this._headerBuf = null;
        if (body.length > 0) {
          this._processPcmBytes(body);
        }
        cb();
        return;
      }

      this._processPcmBytes(chunk);
      cb();
    } catch (err) {
      cb(err);
    }
  }

  _processPcmBytes(buf) {
    if (this._bitsPerSample !== 16) {
      throw new Error(`Format WAV ${this._bitsPerSample}-bit belum didukung tanpa FFmpeg`);
    }

    const combined = this._leftover.length > 0 ? Buffer.concat([this._leftover, buf]) : buf;
    const frameBytesIn = this._channels * 2;
    const totalInputFrames = Math.floor(combined.length / frameBytesIn);
    if (totalInputFrames <= 0) {
      this._leftover = combined;
      return;
    }

    const consumedBytes = totalInputFrames * frameBytesIn;
    this._leftover = combined.subarray(consumedBytes);

    // Jika sudah 48kHz Stereo s16le, teruskan langsung dengan zero-copy
    if (this._sampleRate === 48000 && this._channels === 2) {
      this.push(combined.subarray(0, consumedBytes));
      return;
    }

    // Resampling linear ringan ke 48kHz Stereo
    const outFrames = Math.max(1, Math.round((totalInputFrames * 48000) / this._sampleRate));
    const outBuf = Buffer.allocUnsafe(outFrames * 4);
    const ratio = this._sampleRate / 48000;

    for (let i = 0; i < outFrames; i += 1) {
      const srcIdx = Math.min(totalInputFrames - 1, Math.floor(i * ratio));
      const baseOffset = srcIdx * frameBytesIn;
      const left = combined.readInt16LE(baseOffset);
      const right = this._channels >= 2 ? combined.readInt16LE(baseOffset + 2) : left;
      outBuf.writeInt16LE(left, i * 4);
      outBuf.writeInt16LE(right, i * 4 + 2);
    }
    this.push(outBuf);
  }
}

/**
 * Mengintip beberapa byte pertama stream untuk mendeteksi format kontainer secara akurat
 * (Ogg Opus "OggS", WebM/Matroska 0x1A45DFA3, WAV "RIFF....WAVE", atau Arbitrary).
 */
function peekStreamSignature(readableStream, minBytes = 64, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Timeout saat membaca header awal stream audio'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      readableStream.off('data', onData);
      readableStream.off('end', onEnd);
      readableStream.off('error', onError);
    }

    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      readableStream.pause();

      const head = Buffer.concat(chunks);
      const replay = new PassThrough();
      if (head.length > 0) {
        replay.write(head);
      }
      readableStream.pipe(replay);
      readableStream.resume();
      resolve({ head, stream: replay });
    }

    function onData(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= minBytes) {
        finish();
      }
    }

    function onEnd() {
      finish();
    }

    function onError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    readableStream.on('data', onData);
    readableStream.once('end', onEnd);
    readableStream.once('error', onError);
  });
}

function detectContainerFromSignature(head, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'OggS') {
    return 'ogg-opus';
  }
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return 'webm-opus';
  }
  if (
    head.length >= 12 &&
    head.toString('ascii', 0, 4) === 'RIFF' &&
    head.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'wav-pcm';
  }
  if (ct.includes('audio/ogg') || ct.includes('application/ogg') || ct.includes('audio/opus')) {
    return 'ogg-opus';
  }
  if (ct.includes('audio/webm')) {
    return 'webm-opus';
  }
  return 'arbitrary';
}

/**
 * Mengekstrak URL stream langsung yang sah untuk SoundCloud / Bandcamp / HTTP apabila tersedia.
 */
async function resolveLegitimateStreamUrl(track, { allowLoopback = false } = {}) {
  if (!track) return null;
  const candidateUri = track.directStreamUrl || track.info?.uri || '';
  if (!candidateUri || !/^https?:\/\//i.test(candidateUri)) {
    return null;
  }

  const parsed = new URL(candidateUri);
  if (!allowLoopback && isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error('URL lokal/privat ditolak demi keamanan SSRF.');
  }

  const host = parsed.hostname.toLowerCase();
  const srcName = String(track.info?.sourceName || track.originalSource || '').toLowerCase();

  // 1. Direct HTTP Audio URL
  if (
    track.directStreamUrl ||
    srcName === 'http' ||
    /\.(ogg|opus|webm|wav|mp3|flac|m4a|aac|m3u8)(\?.*)?$/i.test(parsed.pathname)
  ) {
    return candidateUri;
  }

  // 2. Bandcamp halaman publik -> ekstrak stream mp3-128 resmi dari atribut data-tralbum
  if (host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) {
    const res = await fetch(candidateUri, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LaguKanBot/1.0)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const tralbumMatch = html.match(/data-tralbum="([^"]+)"/i);
    if (tralbumMatch && tralbumMatch[1]) {
      const decodedJson = tralbumMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'");
      const data = JSON.parse(decodedJson);
      const fileObj = data?.trackinfo?.[0]?.file;
      const streamUrl = fileObj?.['mp3-128'] || Object.values(fileObj || {})[0] || null;
      if (streamUrl && /^https?:\/\//i.test(streamUrl)) {
        return streamUrl;
      }
    }
    return null;
  }

  // 3. SoundCloud halaman publik -> ekstrak progressive Ogg Opus / MP3 melalui hydration publik
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
    const pageRes = await fetch(candidateUri, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000)
    });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const hydrationMatch = html.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
    const scriptUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(
      (m) => m[1]
    );

    if (!hydrationMatch || scriptUrls.length === 0) return null;
    const hydration = JSON.parse(hydrationMatch[1]);
    const soundEntry = hydration.find((item) => item?.hydratable === 'sound' && item?.data?.media?.transcodings);
    const transcodings = soundEntry?.data?.media?.transcodings;
    if (!Array.isArray(transcodings) || transcodings.length === 0) return null;

    // Prioritaskan progressive Ogg Opus (dapat didemux langsung tanpa FFmpeg!), lalu progressive MP3
    const chosen =
      transcodings.find(
        (t) => t?.format?.protocol === 'progressive' && /ogg|opus/i.test(t?.format?.mime_type || '')
      ) ||
      transcodings.find((t) => t?.format?.protocol === 'progressive') ||
      null;
    if (!chosen?.url) return null;

    let clientId = null;
    for (const jsUrl of scriptUrls.slice(-3).reverse()) {
      const jsRes = await fetch(jsUrl, { signal: AbortSignal.timeout(6000) }).catch(() => null);
      if (!jsRes?.ok) continue;
      const jsText = await jsRes.text();
      const cidMatch = jsText.match(/client_id\s*:\s*"([A-Za-z0-9]{32})"/);
      if (cidMatch) {
        clientId = cidMatch[1];
        break;
      }
    }
    if (!clientId) return null;

    const sep = chosen.url.includes('?') ? '&' : '?';
    const trackAuth = soundEntry?.data?.track_authorization
      ? `&track_authorization=${encodeURIComponent(soundEntry.data.track_authorization)}`
      : '';
    const resolveRes = await fetch(`${chosen.url}${sep}client_id=${clientId}${trackAuth}`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!resolveRes.ok) return null;
    const streamJson = await resolveRes.json();
    return streamJson?.url || null;
  }

  return null;
}

/**
 * Engine suara langsung berbasis @discordjs/voice v0.19.2 + @snazzah/davey (Discord DAVE E2EE Protocol v1).
 * Digunakan sebagai jembatan terenkripsi penuh di Android Termux ARM64 apabila proses Lavalink
 * dijalankan pada Bionic tanpa glibc (yang terkena Close 4017 DAVE_E2EE_NATIVE_MISSING).
 * TIDAK PERNAH menonaktifkan enkripsi DAVE atau AEAD Discord!
 */
class DirectDaveVoiceSession {
  /**
   * @param {object} options
   * @param {import('discord.js').Guild} options.guild
   * @param {string} options.voiceChannelId
   * @param {import('../client').LaguKanClient} options.client
   * @param {Function} [options.onTrackEnd]
   * @param {Function} [options.onTrackError]
   * @param {boolean} [options.allowLoopback]
   */
  constructor({
    guild,
    voiceChannelId,
    client,
    onTrackEnd = null,
    onTrackError = null,
    allowLoopback = false
  }) {
    this.guild = guild;
    this.guildId = String(guild.id);
    this.voiceChannelId = String(voiceChannelId);
    this.client = client;
    this.onTrackEnd = onTrackEnd;
    this.onTrackError = onTrackError;
    this.allowLoopback = Boolean(allowLoopback);

    this.connection = null;
    this.audioPlayer = null;
    this.currentResource = null;
    this.activeAbortController = null;
    this.packetsSent = 0;
    this.destroyed = false;
    this.suppressIdleCallback = false;
    this._hookedUdpSocket = null;
  }

  /**
   * Memastikan protokol enkripsi DAVE E2EE tersedia secara native/WASM sebelum bergabung ke voice.
   */
  _assertDaveEncryptionReady() {
    if (!davey || typeof davey.DAVESession !== 'function' || Number(davey.DAVE_PROTOCOL_VERSION) < 1) {
      throw new Error(
        'Library enkripsi Discord DAVE (@snazzah/davey) tidak tersedia. Enkripsi DAVE wajib aktif sesuai standar keamanan Discord.'
      );
    }
  }

  /**
   * Memasang penghitung paket RTP terenkripsi pada socket UDP untuk membuktikan transmisi audio nyata.
   */
  _instrumentUdpTelemetry() {
    const netState = this.connection?.state?.networking?.state;
    const udp = netState?.udp;
    if (!udp || udp === this._hookedUdpSocket) return;

    this._hookedUdpSocket = udp;
    const origSend = udp.send.bind(udp);
    udp.send = (buffer, ...rest) => {
      this.packetsSent += 1;
      return origSend(buffer, ...rest);
    };
  }

  async connect(timeoutMs = 12000) {
    this._assertDaveEncryptionReady();

    // Lepaskan listener koneksi Shoukaku untuk guild ini (tanpa mengirim channel_id: null)
    // agar Shoukaku tidak berebut event VOICE_SERVER_UPDATE dengan @discordjs/voice.
    if (this.client?.shoukaku) {
      const oldPlayer = this.client.shoukaku.players?.get(this.guildId);
      if (oldPlayer) {
        await oldPlayer.stopTrack().catch(() => {});
        oldPlayer.removeAllListeners?.();
        this.client.shoukaku.players.delete(this.guildId);
      }
      for (const node of this.client.shoukaku.nodes?.values?.() || []) {
        node.players?.delete?.(this.guildId);
      }
      this.client.shoukaku.connections?.delete?.(this.guildId);
    }

    if (
      !this.connection ||
      this.connection.state.status === VoiceConnectionStatus.Destroyed ||
      this.connection.state.status === VoiceConnectionStatus.Disconnected
    ) {
      this.connection = joinVoiceChannel({
        guildId: this.guildId,
        channelId: this.voiceChannelId,
        adapterCreator: this.guild.voiceAdapterCreator,
        group: `lagukan-dave-${this.guildId}`,
        selfDeaf: true,
        selfMute: false,
        // KEAMANAN MUTLAK: Enkripsi DAVE E2EE WAJIB true, tidak pernah dinonaktifkan!
        daveEncryption: true
      });

      this.connection.on('stateChange', () => {
        this._instrumentUdpTelemetry();
      });

      this.connection.on('error', (err) => {
        logger.warn(`[Guild ${this.guildId}] Error koneksi Direct DAVE Voice: ${err.message}`);
      });
    }

    await entersState(this.connection, VoiceConnectionStatus.Ready, timeoutMs);
    this._instrumentUdpTelemetry();

    if (!this.audioPlayer) {
      this.audioPlayer = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
          maxMissedFrames: 15
        }
      });

      this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
        if (this.destroyed || this.suppressIdleCallback) return;
        if (typeof this.onTrackEnd === 'function') {
          this.onTrackEnd({ reason: 'finished' });
        }
      });

      this.audioPlayer.on('error', (err) => {
        if (this.destroyed) return;
        logger.error(`[Guild ${this.guildId}] AudioPlayer error pada Direct DAVE Voice`, err);
        if (typeof this.onTrackError === 'function') {
          this.onTrackError(err);
        }
      });

      this.connection.subscribe(this.audioPlayer);
    }

    const netState = this.connection?.state?.networking?.state;
    const daveProto = netState?.dave?.protocolVersion ?? davey.DAVE_PROTOCOL_VERSION;
    logger.info(
      `[DirectDaveVoice] ✅ Terhubung ke Discord Voice v8 dengan DAVE E2EE aktif (guild=${this.guildId}, channel=${this.voiceChannelId}, daveProtocol=v${daveProto})`
    );
    return this.connection;
  }

  /**
   * Memutar track menggunakan stream sah yang dienkripsi DAVE E2EE & memverifikasi paket RTP benar-benar mengalir.
   */
  async playTrack(track, { volume = 100, timeoutMs = 10000 } = {}) {
    await this.connect(timeoutMs);

    const streamUrl = await resolveLegitimateStreamUrl(track, {
      allowLoopback: this.allowLoopback
    });

    if (!streamUrl) {
      throw new Error(
        'Sumber lagu ini membutuhkan proses Lavalink di dalam runtime Debian ARM64 glibc (`./scripts/start-lavalink-termux.sh`) agar dekoder penuh & libdave-jvm aktif.'
      );
    }

    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const response = await fetch(streamUrl, {
      headers: {
        'User-Agent': 'LaguKan-MusicBot/1.0'
      },
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`Stream audio mengembalikan HTTP ${response.status}`);
    }

    const nodeReadable = Readable.fromWeb(response.body);
    const { head, stream: replayStream } = await peekStreamSignature(nodeReadable, 64, 6000);
    const container = detectContainerFromSignature(
      head,
      response.headers.get('content-type') || ''
    );

    const daveSupport = inspectDaveSupport();
    let resource;

    if (container === 'ogg-opus') {
      const needInlineVol = Math.round(volume) !== 100 && Boolean(daveSupport.opusLibrary);
      resource = createAudioResource(replayStream, {
        inputType: StreamType.OggOpus,
        inlineVolume: needInlineVol,
        metadata: { track }
      });
    } else if (container === 'webm-opus') {
      const needInlineVol = Math.round(volume) !== 100 && Boolean(daveSupport.opusLibrary);
      resource = createAudioResource(replayStream, {
        inputType: StreamType.WebmOpus,
        inlineVolume: needInlineVol,
        metadata: { track }
      });
    } else if (container === 'wav-pcm') {
      if (!daveSupport.opusLibrary) {
        replayStream.destroy();
        throw new Error('Encoder Opus (opusscript) belum terpasang untuk memproses stream PCM.');
      }
      const pcmStream = replayStream.pipe(new WavTo48kStereoPcmTransformer());
      resource = createAudioResource(pcmStream, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata: { track }
      });
    } else {
      if (!daveSupport.hasFfmpeg) {
        replayStream.destroy();
        throw new Error(
          'Format audio MP3/AAC ini membutuhkan paket `ffmpeg` (`pkg install -y ffmpeg` di Termux) atau jalankan Lavalink via `./scripts/start-lavalink-termux.sh`.'
        );
      }
      resource = createAudioResource(replayStream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
        metadata: { track }
      });
    }

    if (resource.volume && typeof volume === 'number') {
      resource.volume.setVolume(Math.max(0, volume) / 100);
    }

    const packetsBefore = this.packetsSent;
    this.suppressIdleCallback = true;
    this.currentResource = resource;
    this.audioPlayer.play(resource);
    this.suppressIdleCallback = false;

    await entersState(this.audioPlayer, AudioPlayerStatus.Playing, timeoutMs);
    this._instrumentUdpTelemetry();

    // Tunggu minimal 3 frame Opus nyata (60ms) terkirim melalui UDP terenkripsi sebelum mengklaim PLAYING!
    const verifyStart = Date.now();
    while (Date.now() - verifyStart < 2500) {
      if (this.destroyed) {
        throw new Error('Sesi Direct DAVE Voice dihentikan saat verifikasi paket');
      }
      if (
        this.audioPlayer.state.status === AudioPlayerStatus.Playing &&
        (this.packetsSent > packetsBefore || resource.playbackDuration >= 40)
      ) {
        const ping = this.connection?.ping?.udp ?? this.connection?.ping?.ws ?? 0;
        logger.info(
          `[DirectDaveVoice] 📡 Transmisi paket Opus DAVE E2EE terverifikasi: guild=${this.guildId}, container=${container}, packetsSent=${this.packetsSent}, playbackDuration=${resource.playbackDuration}ms`
        );
        return {
          started: true,
          container,
          ping: typeof ping === 'number' ? ping : 0,
          packetsSent: this.packetsSent
        };
      }
      if (this.audioPlayer.state.status === AudioPlayerStatus.Idle) {
        throw new Error('Stream audio berhenti prematur sebelum paket suara terkirim (0 frame)');
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    throw new Error('Timeout menunggu pengiriman paket RTP Opus ke Discord Voice UDP');
  }

  setPaused(paused) {
    if (!this.audioPlayer) return;
    if (paused) {
      this.audioPlayer.pause(true);
    } else {
      this.audioPlayer.unpause();
    }
  }

  setVolume(volumePercent) {
    if (this.currentResource?.volume) {
      this.currentResource.volume.setVolume(Math.max(0, Number(volumePercent || 100)) / 100);
      return true;
    }
    return false;
  }

  getPlaybackPositionMs() {
    return Number(this.currentResource?.playbackDuration || 0);
  }

  getPingMs() {
    const udpPing = this.connection?.ping?.udp;
    if (typeof udpPing === 'number' && Number.isFinite(udpPing)) return udpPing;
    const wsPing = this.connection?.ping?.ws;
    if (typeof wsPing === 'number' && Number.isFinite(wsPing)) return wsPing;
    return -1;
  }

  stopTrack() {
    this.suppressIdleCallback = true;
    try {
      if (this.activeAbortController) {
        this.activeAbortController.abort();
        this.activeAbortController = null;
      }
      if (this.audioPlayer) {
        this.audioPlayer.stop(true);
      }
      this.currentResource = null;
    } finally {
      this.suppressIdleCallback = false;
    }
  }

  destroy() {
    this.destroyed = true;
    this.stopTrack();
    if (this.audioPlayer) {
      this.audioPlayer.removeAllListeners();
      this.audioPlayer = null;
    }
    if (this.connection) {
      try {
        if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          this.connection.destroy();
        }
      } catch {
        // Abaikan
      }
      this.connection = null;
    }
  }
}

module.exports = {
  DirectDaveVoiceSession,
  WavTo48kStereoPcmTransformer,
  resolveLegitimateStreamUrl,
  detectContainerFromSignature
};
