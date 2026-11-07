'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const logger = require('../utils/logger');

const MAX_ERROR_HISTORY = 25;

// Daftar client YouTube yang TIDAK mengembalikan format WebM Opus (selalu memaksa transcoding AAC/MP4)
const NON_OPUS_YOUTUBE_CLIENTS = new Set(['IOS', 'TV']);
// Client metadata-only (tidak dipakai untuk memutar stream audio langsung)
const METADATA_ONLY_CLIENTS = new Set(['MUSIC']);

/**
 * Mendeteksi lingkungan sistem operasi, arsitektur CPU, dan runtime Android Termux ARM64.
 */
function detectRuntimeEnvironment() {
  const platform = process.platform;
  const arch = process.arch;
  const release = os.release();
  const isTermux = Boolean(
    process.env.TERMUX_VERSION ||
    (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) ||
    fs.existsSync('/data/data/com.termux/files/usr')
  );
  const isAndroidKernel =
    isTermux ||
    platform === 'android' ||
    /android/i.test(release);

  let hasProotDistro = false;
  if (isTermux) {
    const prefixBin = process.env.PREFIX
      ? path.join(process.env.PREFIX, 'bin', 'proot-distro')
      : '/data/data/com.termux/files/usr/bin/proot-distro';
    hasProotDistro = fs.existsSync(prefixBin);
  }

  return {
    platform,
    arch,
    release,
    nodeVersion: process.version,
    cpuCores: os.cpus()?.length || 1,
    cpuModel: os.cpus()?.[0]?.model || 'ARM64 / Generic CPU',
    isTermux,
    isAndroidBionic: isAndroidKernel,
    termuxVersion: process.env.TERMUX_VERSION || null,
    hasProotDistro
  };
}

/**
 * Membaca versi Java lokal secara aman jika diperlukan untuk diagnostik ketika Lavalink offline.
 */
function detectLocalJavaVersion() {
  try {
    const out = execFileSync('java', ['-version'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return String(out || '').split('\n')[0].trim() || null;
  } catch (err) {
    const stderr = String(err?.stderr || '').trim();
    if (stderr) {
      return stderr.split('\n')[0].trim();
    }
    return null;
  }
}

/**
 * Menginspeksi file application.yml lokal (jika tersedia) TANPA membaca password, refreshToken, atau poToken.
 */
function inspectLocalLavalinkConfig() {
  const home = os.homedir();
  const candidates = [
    process.env.LAVALINK_CONFIG_PATH,
    path.resolve(process.cwd(), 'application.yml'),
    path.resolve(process.cwd(), '../lavalink/application.yml'),
    path.join(home, 'lavalink', 'application.yml'),
    path.join(home, 'Lavalink', 'application.yml')
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const content = fs.readFileSync(filePath, 'utf8');

      // Ekstrak daftar clients di bawah blok plugins.youtube.clients secara aman
      const clients = [];
      const lines = content.split(/\r?\n/);
      let inClientsList = false;
      let clientsIndent = -1;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const indent = line.search(/\S/);
        if (/^clients\s*:\s*$/.test(trimmed)) {
          inClientsList = true;
          clientsIndent = indent;
          continue;
        }

        if (inClientsList) {
          if (indent > clientsIndent && trimmed.startsWith('-')) {
            const clientName = trimmed
              .replace(/^-\s*/, '')
              .replace(/#.*$/, '')
              .replace(/['"]/g, '')
              .trim();
            if (clientName) clients.push(clientName);
          } else if (indent <= clientsIndent) {
            inClientsList = false;
          }
        }
      }

      const bufferMatch = content.match(/^\s*bufferDurationMs\s*:\s*(\d+)/m);
      const remoteCipherMatch = content.match(/^\s*remoteCipher\s*:/m);
      const oauthEnabledMatch = content.match(/oauth\s*:[\s\S]{0,160}?enabled\s*:\s*(true|false)/m);

      const nonOpusClients = clients.filter(
        (c) => NON_OPUS_YOUTUBE_CLIENTS.has(c.toUpperCase())
      );
      const opusClients = clients.filter(
        (c) =>
          !NON_OPUS_YOUTUBE_CLIENTS.has(c.toUpperCase()) &&
          !METADATA_ONLY_CLIENTS.has(c.toUpperCase())
      );

      return {
        found: true,
        locationLabel: path.basename(path.dirname(filePath)) + '/' + path.basename(filePath),
        youtubeClients: clients,
        opusClients,
        nonOpusClients,
        bufferDurationMs: bufferMatch ? Number.parseInt(bufferMatch[1], 10) : null,
        hasRemoteCipher: Boolean(remoteCipherMatch),
        oauthEnabled: oauthEnabledMatch ? oauthEnabledMatch[1] === 'true' : false
      };
    } catch {
      // Abaikan jika file tidak dapat diakses
    }
  }

  return {
    found: false,
    locationLabel: null,
    youtubeClients: [],
    opusClients: [],
    nonOpusClients: [],
    bufferDurationMs: null,
    hasRemoteCipher: false,
    oauthEnabled: false
  };
}

/**
 * Mengklasifikasikan penyebab kegagalan pemuatan / dekode audio dari Lavalink secara akurat.
 */
function classifyTrackFailure(rawException) {
  const msg = String(
    rawException?.message ||
    rawException?.cause ||
    rawException ||
    ''
  );
  const cause = String(rawException?.cause || '');
  const stack = String(rawException?.causeStackTrace || rawException?.stack || '');
  const combined = logger.redactSecrets(`${msg}\n${cause}\n${stack}`);

  if (
    /AacDecoderLibrary|NativeLibraryLoader|ConnectorNativeLibLoader|libconnector|OpusDecoderLibrary|Mp3DecoderLibrary|UnsatisfiedLinkError|libgcc_s\.so|libc\.so\.6/i.test(
      combined
    )
  ) {
    return {
      code: 'ANDROID_JNI_DECODER_UNSUPPORTED',
      isNativeJniFailure: true,
      shortReason: 'Decoder native JNI (libconnector.so / AAC) gagal dimuat pada Android Bionic',
      userMessage:
        'Server Lavalink mencoba memuat decoder native GNU `glibc` (`AacDecoderLibrary` / `libconnector.so`) yang tidak kompatibel dengan Java Android Bionic standar. LaguKan otomatis mengaktifkan **Pure-Java Opus Passthrough (Volume 100%)** dan mengalihkan sumber audio. Agar format AAC/MP4/filter juga didukung penuh di Termux, jalankan Lavalink melalui `./scripts/start-lavalink-termux.sh` (`proot-distro` Debian ARM64) dan hapus client `IOS` dari `application.yml`.'
    };
  }

  if (/libdave|DaveNativeBindings|4017/i.test(combined)) {
    return {
      code: 'DAVE_E2EE_NATIVE_MISSING',
      isNativeJniFailure: true,
      shortReason: 'Library enkripsi suara Discord DAVE (libdave-jvm) tidak dapat dimuat di Bionic',
      userMessage:
        'Koneksi enkripsi suara Discord DAVE (`libdave-jvm`) membutuhkan runtime Linux `glibc` pada ARM64. Jalankan Lavalink di Termux menggunakan `./scripts/start-lavalink-termux.sh --setup-glibc` lalu `./scripts/start-lavalink-termux.sh`.'
    };
  }

  if (/No supported audio streams available|serverAbrStreamingUrl|SABR/i.test(combined)) {
    return {
      code: 'YOUTUBE_SABR_NO_STREAMS',
      isNativeJniFailure: false,
      shortReason: 'Client YouTube hanya mengembalikan stream SABR tanpa format audio langsung',
      userMessage:
        'Client YouTube (`WEB`) tidak menyediakan stream audio langsung (pembatasan SABR YouTube). Pastikan `ANDROID_VR`, `ANDROID_MUSIC`, dan `TVHTML5_SIMPLY` berada di urutan atas `clients` pada `application.yml`.'
    };
  }

  if (
    /requires login|Sign in to confirm|not a bot|AllClientsFailedException|ScriptExtractionException|status code:\s*403|player api response:\s*400/i.test(
      combined
    )
  ) {
    return {
      code: 'YOUTUBE_AUTH_OR_CIPHER_BLOCKED',
      isNativeJniFailure: false,
      shortReason: 'Stream YouTube ditolak (pembatasan IP/OAuth/Cipher pada client YouTube)',
      userMessage:
        'Seluruh client YouTube pada Lavalink gagal membuka stream lagu ini (pembatasan IP seluler/OAuth/cipher). Perbarui `application.yml` sesuai `config/application.yml.example` atau gunakan sumber alternatif seperti SoundCloud.'
    };
  }

  if (/timed out|ECONNRESET|ECONNREFUSED|503|502|Network/i.test(combined)) {
    return {
      code: 'NETWORK_STREAM_ERROR',
      isNativeJniFailure: false,
      shortReason: 'Gangguan jaringan saat mengambil stream audio dari sumber',
      userMessage:
        'Terjadi gangguan koneksi jaringan saat server Lavalink mengunduh stream audio. Coba ulangi beberapa saat lagi.'
    };
  }

  const sanitizedSummary = logger
    .redactSecrets(msg || cause || 'Kesalahan pemuatan/dekode audio tidak diketahui')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);

  return {
    code: 'GENERIC_TRACK_FAILURE',
    isNativeJniFailure: false,
    shortReason: sanitizedSummary || 'Gagal memuat/mendekode track',
    userMessage: `Gagal memutar sumber audio lagu ini (${sanitizedSummary || 'kesalahan dekode pada Lavalink'}).`
  };
}

class AudioDiagnostics {
  constructor() {
    this.runtime = detectRuntimeEnvironment();
    /** @type {Array<object>} */
    this.errorHistory = [];
    /** @type {Map<string, { broken: boolean, code: string, detectedAt: number, detail: string }>} */
    this.nodeNativeStatus = new Map();
    /** @type {Map<string, { stage: number, name: string, detail: string, updatedAt: number }>} */
    this.guildPipelineStage = new Map();
  }

  /**
   * Mencatat progres 9 tahap pipeline pemutaran suara Discord untuk observabilitas & /debugmusic.
   */
  recordStage(guildId, stageNumber, stageName, detail = '') {
    if (!guildId) return;
    const safeDetail = logger.redactSecrets(String(detail || '')).slice(0, 240);
    this.guildPipelineStage.set(String(guildId), {
      stage: stageNumber,
      name: stageName,
      detail: safeDetail,
      updatedAt: Date.now()
    });
    logger.info(`[Pipeline ${stageNumber}/9][Guild ${guildId}] ${stageName}${safeDetail ? ` — ${safeDetail}` : ''}`);
  }

  getGuildStage(guildId) {
    return this.guildPipelineStage.get(String(guildId)) || null;
  }

  clearGuildStage(guildId) {
    this.guildPipelineStage.delete(String(guildId));
  }

  /**
   * Mencatat error pemuatan / dekode lagu ke ring buffer terstruktur tanpa membocorkan kredensial.
   */
  recordTrackError({ guildId, nodeName, track, stage = 'DECODE', rawException }) {
    const diagnosis = classifyTrackFailure(rawException);
    const entry = {
      timestamp: Date.now(),
      guildId: guildId ? String(guildId) : 'global',
      nodeName: nodeName || 'unknown',
      stage,
      trackTitle: String(track?.info?.title || 'Tidak diketahui').slice(0, 100),
      trackSource: String(track?.info?.sourceName || track?.originalSource || 'unknown'),
      code: diagnosis.code,
      reason: diagnosis.shortReason
    };

    this.errorHistory.unshift(entry);
    if (this.errorHistory.length > MAX_ERROR_HISTORY) {
      this.errorHistory.length = MAX_ERROR_HISTORY;
    }

    if (diagnosis.isNativeJniFailure && nodeName) {
      this.nodeNativeStatus.set(String(nodeName), {
        broken: true,
        code: diagnosis.code,
        detectedAt: Date.now(),
        detail: diagnosis.shortReason
      });
    }

    return diagnosis;
  }

  isNativeDecoderBroken(nodeName) {
    if (!nodeName) return false;
    return Boolean(this.nodeNativeStatus.get(String(nodeName))?.broken);
  }

  clearNodeNativeStatus(nodeName) {
    if (!nodeName) return;
    this.nodeNativeStatus.delete(String(nodeName));
  }

  getNodeNativeStatus(nodeName) {
    if (!nodeName) return null;
    return this.nodeNativeStatus.get(String(nodeName)) || null;
  }

  getRecentErrors(guildId = null, limit = 5) {
    const filtered = guildId
      ? this.errorHistory.filter((e) => e.guildId === String(guildId) || e.guildId === 'global')
      : this.errorHistory;
    return filtered.slice(0, limit);
  }
}

module.exports = {
  AudioDiagnostics,
  detectRuntimeEnvironment,
  detectLocalJavaVersion,
  inspectLocalLavalinkConfig,
  classifyTrackFailure,
  NON_OPUS_YOUTUBE_CLIENTS
};
