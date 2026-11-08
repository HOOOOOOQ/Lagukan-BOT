'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const logger = require('../utils/logger');
const { config } = require('../../config/config');

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
 * Mengaudit dukungan protokol Discord DAVE E2EE, kriptografi AEAD, Opus, dan FFmpeg pada Node.js ARM64.
 */
function inspectDaveSupport() {
  const result = {
    voiceVersion: null,
    daveyLoaded: false,
    daveyVersion: null,
    daveProtocolVersion: 0,
    daveBindingType: 'unavailable',
    hasAes256Gcm: crypto.getCiphers().includes('aes-256-gcm'),
    hasXChaCha20Poly1305: false,
    nobleCiphersVersion: null,
    opusLibrary: null,
    hasFfmpeg: false
  };

  try {
    const voiceMod = require('@discordjs/voice');
    result.voiceVersion = voiceMod.version || null;
  } catch {
    // Abaikan
  }

  try {
    const davey = require('@snazzah/davey');
    result.daveyLoaded = typeof davey.DAVESession === 'function';
    result.daveyVersion = davey.VERSION || require('@snazzah/davey/package.json').version;
    result.daveProtocolVersion = Number(davey.DAVE_PROTOCOL_VERSION || 0);

    // Deteksi jenis paket native/WASM yang tersedia untuk platform saat ini
    const platformCandidates = [
      process.platform === 'android' && process.arch === 'arm64'
        ? ['@snazzah/davey-android-arm64', 'native:android-arm64']
        : null,
      process.platform === 'linux' && process.arch === 'arm64'
        ? ['@snazzah/davey-linux-arm64-gnu', 'native:linux-arm64-gnu']
        : null,
      process.platform === 'linux' && process.arch === 'x64'
        ? ['@snazzah/davey-linux-x64-gnu', 'native:linux-x64-gnu']
        : null,
      ['@snazzah/davey-wasm32-wasi', 'wasm32-wasi']
    ].filter(Boolean);

    for (const [pkgName, label] of platformCandidates) {
      try {
        require.resolve(pkgName);
        result.daveBindingType = label;
        break;
      } catch {
        // Lanjut cek kandidat berikutnya
      }
    }
  } catch {
    result.daveyLoaded = false;
  }

  try {
    const chacha = require('@noble/ciphers/chacha.js');
    if (typeof chacha.xchacha20poly1305 === 'function') {
      result.hasXChaCha20Poly1305 = true;
      result.nobleCiphersVersion = require('@noble/ciphers/package.json').version;
    }
  } catch {
    // Abaikan
  }

  try {
    const opusPkg = require('opusscript/package.json');
    result.opusLibrary = `opusscript@${opusPkg.version}`;
  } catch {
    try {
      const djsOpusPkg = require('@discordjs/opus/package.json');
      result.opusLibrary = `@discordjs/opus@${djsOpusPkg.version}`;
    } catch {
      result.opusLibrary = null;
    }
  }

  for (const bin of ['ffmpeg', 'avconv']) {
    try {
      execFileSync(bin, ['-version'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      result.hasFfmpeg = true;
      break;
    } catch {
      // Tidak tersedia
    }
  }

  return result;
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
      const clientOptionsMatch = content.match(/^\s*clientOptions\s*:/m);
      const oauthEnabledMatch = content.match(/oauth\s*:[\s\S]{0,160}?enabled\s*:\s*(true|false)/m);
      const pluginVerMatch = content.match(/youtube-plugin:([^\s"']+)/);

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
        hasClientOptions: Boolean(clientOptionsMatch),
        youtubePluginVersion: pluginVerMatch ? pluginVerMatch[1] : null,
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
    hasClientOptions: false,
    youtubePluginVersion: null,
    oauthEnabled: false
  };
}

/**
 * Mengekstrak ringkasan per-client secara aman dari pesan AllClientsFailedException youtube-source.
 */
function summarizeClientExceptions(combinedText) {
  const clientMatches = [];
  const regex = /Client\s*\[([A-Z0-9_]+)\][^:\n]*:\s*([^\r\n]+)/gi;
  let m;
  while ((m = regex.exec(combinedText)) !== null) {
    const clientName = m[1].toUpperCase();
    const reasonRaw = m[2].trim();
    let shortTag = reasonRaw.slice(0, 48);
    if (/Sign in to confirm|not a bot|requires login/i.test(reasonRaw)) {
      shortTag = 'login/bot-check';
    } else if (/403/.test(reasonRaw)) {
      shortTag = 'HTTP 403';
    } else if (/No supported audio streams|SABR/i.test(reasonRaw)) {
      shortTag = 'SABR/no-stream';
    } else if (/400/.test(reasonRaw)) {
      shortTag = 'HTTP 400';
    }
    if (!clientMatches.some((item) => item.startsWith(`${clientName}:`))) {
      clientMatches.push(`${clientName}: ${shortTag}`);
    }
    if (clientMatches.length >= 6) break;
  }
  return clientMatches;
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

  // 1. Autentikasi WebSocket Lavalink (/v4/websocket) — dibedakan tegas dari HTTP 403 stream YouTube!
  if (
    /Authentication failed|\/v4\/websocket|401 Unauthorized|Handshake WebSocket Lavalink ditolak dengan status HTTP 40[13]/i.test(
      combined
    )
  ) {
    return {
      code: 'LAVALINK_WS_AUTH_FAILED',
      isNativeJniFailure: false,
      isYoutubeFailure: false,
      isDaveVoiceFailure: false,
      shortReason: 'Autentikasi WebSocket Lavalink (/v4/websocket) gagal (HTTP 401/403)',
      userMessage:
        'Autentikasi WebSocket ke server Lavalink ditolak (`GET /v4/websocket` HTTP 401/403). Samakan nilai `LAVALINK_PASSWORD` di `.env` dengan `lavalink.server.password` di `application.yml`, atau jalankan `./scripts/start-lavalink-termux.sh` untuk menyinkronkannya otomatis.'
    };
  }

  // 2. Masalah Kompatibilitas Native DAVE E2EE (libdave-jvm / Close 4017) — diinvestigasi & ditangani terpisah!
  if (/libdave|DaveNativeBindings|DAVE protocol|Close 4017|\b4017\b/i.test(combined)) {
    return {
      code: 'DAVE_E2EE_NATIVE_MISSING',
      isNativeJniFailure: true,
      isYoutubeFailure: false,
      isDaveVoiceFailure: true,
      shortReason: 'Library native DAVE E2EE Lavalink (libdave-jvm.so) gagal dimuat pada Android Bionic (Close 4017)',
      userMessage:
        'Server Lavalink menolak enkripsi suara Discord DAVE (`Close 4017` / `libdave-jvm.so` membutuhkan `glibc`, bukan Android Bionic murni). Jalankan Lavalink melalui `./scripts/start-lavalink-termux.sh` (`proot-distro` Debian ARM64 `glibc`), atau LaguKan akan memakai engine **Direct DAVE E2EE Node.js (`@snazzah/davey` ARM64)** untuk sumber langsung yang didukung.'
    };
  }

  // 3. Transport UDP Voice Lavalink gagal terhubung
  if (
    /VOICE_TRANSPORT_NOT_CONNECTED|state\.connected\s*=\s*false|UDP\/Discord Voice transport/i.test(
      combined
    )
  ) {
    return {
      code: 'VOICE_TRANSPORT_NOT_CONNECTED',
      isNativeJniFailure: false,
      isYoutubeFailure: false,
      isDaveVoiceFailure: true,
      shortReason: 'Transport suara Discord UDP / DAVE Voice Gateway gagal terhubung (state.connected=false)',
      userMessage:
        'Lavalink memuat track namun koneksi suara UDP/DAVE ke Discord gagal (`state.connected = false`, 0 paket audio terkirim). Di Android Termux ARM64, jalankan Lavalink menggunakan `./scripts/start-lavalink-termux.sh` (`proot-distro` Debian `glibc`) agar `libdave-jvm.so` dan UDP voice aktif.'
    };
  }

  // 4. Decoder Native JNI (libconnector.so / AAC) tidak kompatibel di Android Bionic
  if (
    /AacDecoderLibrary|NativeLibraryLoader|ConnectorNativeLibLoader|libconnector|OpusDecoderLibrary|Mp3DecoderLibrary|UnsatisfiedLinkError|libgcc_s\.so|libc\.so\.6/i.test(
      combined
    )
  ) {
    return {
      code: 'ANDROID_JNI_DECODER_UNSUPPORTED',
      isNativeJniFailure: true,
      isYoutubeFailure: false,
      isDaveVoiceFailure: false,
      shortReason: 'Decoder native JNI (libconnector.so / AAC) gagal dimuat pada Android Bionic',
      userMessage:
        'Server Lavalink mencoba memuat decoder native GNU `glibc` (`AacDecoderLibrary` / `libconnector.so`) pada Java Android Bionic. LaguKan otomatis mengaktifkan **Pure-Java Opus Passthrough (Volume 100%)** dan mengalihkan ke sumber Ogg/WebM Opus. Untuk dukungan penuh AAC/MP4/filter di Termux, jalankan `./scripts/start-lavalink-termux.sh`.'
    };
  }

  // 5. Semua Client YouTube Gagal (AllClientsFailedException) — rinci per-client!
  if (/AllClientsFailedException|All clients failed to load the item/i.test(combined)) {
    const clientSummaries = summarizeClientExceptions(combined);
    const hasLoginBot = /Sign in to confirm|not a bot|requires login/i.test(combined);
    const has403 = /\b403\b|status code:\s*403/i.test(combined);
    const detailSuffix = clientSummaries.length > 0 ? ` [${clientSummaries.join(' | ')}]` : '';

    return {
      code: 'YOUTUBE_ALL_CLIENTS_FAILED',
      isNativeJniFailure: false,
      isYoutubeFailure: true,
      isDaveVoiceFailure: false,
      shortReason: `Seluruh client YouTube gagal memuat track${detailSuffix}`.slice(0, 220),
      userMessage:
        `Seluruh client YouTube gagal memuat stream audio lagu ini${
          hasLoginBot
            ? ' akibat deteksi anti-bot/permintaan login YouTube'
            : has403
            ? ' akibat penolakan akses HTTP 403 dari server media YouTube'
            : ''
        }${detailSuffix ? ` (\`${clientSummaries.join(', ')}\`)` : ''}. ` +
        'LaguKan otomatis mengalihkan pencarian ke **SoundCloud / Bandcamp**. Untuk memulihkan YouTube pada Lavalink, jalankan `./scripts/start-lavalink-termux.sh --upgrade-config`.'
    };
  }

  // 6. YouTube meminta login / deteksi anti-bot ("Sign in to confirm you're not a bot")
  if (/Sign in to confirm|not a bot|requires login|Please sign in|Use --cookies/i.test(combined)) {
    return {
      code: 'YOUTUBE_LOGIN_BOT_DETECTION',
      isNativeJniFailure: false,
      isYoutubeFailure: true,
      isDaveVoiceFailure: false,
      shortReason: 'YouTube menolak request karena deteksi bot / meminta login ("Sign in to confirm")',
      userMessage:
        'YouTube menolak pengambilan stream karena deteksi bot / meminta login pada IP saat ini (`Sign in to confirm you’re not a bot`). LaguKan otomatis mengalihkan pemutaran & pencarian ke **SoundCloud / Bandcamp**. Jika ingin membuka blokir IP YouTube di Lavalink, Anda dapat mengatur `pot` (`poToken`) atau `oauth` akun sekunder (burner) pada `application.yml`.'
    };
  }

  // 7. YouTube mengembalikan HTTP 403 Forbidden pada stream audio
  if (/status code:\s*403|HTTP 403|403 Forbidden/i.test(combined)) {
    return {
      code: 'YOUTUBE_HTTP_403_FORBIDDEN',
      isNativeJniFailure: false,
      isYoutubeFailure: true,
      isDaveVoiceFailure: false,
      shortReason: 'Stream media YouTube ditolak dengan HTTP 403 Forbidden',
      userMessage:
        'Client YouTube menerima penolakan **HTTP 403 Forbidden** saat mengambil stream audio. LaguKan otomatis mengalihkan pemutaran ke **SoundCloud / Bandcamp**. Pastikan konfigurasi Lavalink diperbarui dengan `./scripts/start-lavalink-termux.sh --upgrade-config`.'
    };
  }

  // 8. YouTube SABR (Server-Side Adaptive Bitrate tanpa URL stream langsung)
  if (/No supported audio streams available|serverAbrStreamingUrl|SABR/i.test(combined)) {
    return {
      code: 'YOUTUBE_SABR_NO_STREAMS',
      isNativeJniFailure: false,
      isYoutubeFailure: true,
      isDaveVoiceFailure: false,
      shortReason: 'Client YouTube hanya mengembalikan stream SABR tanpa format audio langsung',
      userMessage:
        'Client YouTube tidak menyediakan URL stream audio langsung (pembatasan SABR YouTube). LaguKan mengalihkan lagu ke sumber alternatif yang tersedia (**SoundCloud / Bandcamp**).'
    };
  }

  // 9. Kegagalan ekstraksi signature cipher / player API 400 YouTube
  if (/ScriptExtractionException|player api response:\s*400|cipher/i.test(combined)) {
    return {
      code: 'YOUTUBE_AUTH_OR_CIPHER_BLOCKED',
      isNativeJniFailure: false,
      isYoutubeFailure: true,
      isDaveVoiceFailure: false,
      shortReason: 'Gagal mendekripsi signature cipher / respons Player API 400 YouTube',
      userMessage:
        'Gagal mengekstrak signature cipher stream YouTube (`ScriptExtractionException` / HTTP 400). Pastikan `remoteCipher` aktif di `application.yml` dan koneksi internet ke `cipher.kikkia.dev` lancar.'
    };
  }

  // 10. Gangguan jaringan umum
  if (/timed out|ECONNRESET|ECONNREFUSED|503|502|Network/i.test(combined)) {
    return {
      code: 'NETWORK_STREAM_ERROR',
      isNativeJniFailure: false,
      isYoutubeFailure: false,
      isDaveVoiceFailure: false,
      shortReason: 'Gangguan jaringan saat mengambil stream audio dari sumber',
      userMessage:
        'Terjadi gangguan koneksi jaringan saat mengunduh stream audio. Coba ulangi beberapa saat lagi.'
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
    isYoutubeFailure: false,
    isDaveVoiceFailure: false,
    shortReason: sanitizedSummary || 'Gagal memuat/mendekode track',
    userMessage: `Gagal memutar sumber audio lagu ini (${sanitizedSummary || 'kesalahan dekode pada Lavalink'}).`
  };
}

class AudioDiagnostics {
  constructor() {
    this.runtime = detectRuntimeEnvironment();
    this.daveSupport = inspectDaveSupport();
    /** @type {Array<object>} */
    this.errorHistory = [];
    /** @type {Map<string, { broken: boolean, code: string, detectedAt: number, detail: string }>} */
    this.nodeNativeStatus = new Map();
    /** @type {Map<string, { daveBroken: boolean, code: string, detectedAt: number, detail: string }>} */
    this.nodeDaveStatus = new Map();
    /** @type {Map<string, { degradedUntil: number, code: string, reason: string, failCount: number }>} */
    this.nodeYoutubeHealth = new Map();
    /** @type {Map<string, { authenticated: boolean, error: string|null, updatedAt: number }>} */
    this.nodeAuthStatus = new Map();
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
    const trackSource = String(track?.info?.sourceName || track?.originalSource || 'unknown');
    const entry = {
      timestamp: Date.now(),
      guildId: guildId ? String(guildId) : 'global',
      nodeName: nodeName || 'unknown',
      stage,
      trackTitle: String(track?.info?.title || 'Tidak diketahui').slice(0, 100),
      trackSource,
      code: diagnosis.code,
      reason: diagnosis.shortReason
    };

    this.errorHistory.unshift(entry);
    if (this.errorHistory.length > MAX_ERROR_HISTORY) {
      this.errorHistory.length = MAX_ERROR_HISTORY;
    }

    if (diagnosis.isNativeJniFailure && !diagnosis.isDaveVoiceFailure && nodeName) {
      this.nodeNativeStatus.set(String(nodeName), {
        broken: true,
        code: diagnosis.code,
        detectedAt: Date.now(),
        detail: diagnosis.shortReason
      });
    }

    if (diagnosis.isDaveVoiceFailure && nodeName) {
      this.nodeDaveStatus.set(String(nodeName), {
        daveBroken: true,
        code: diagnosis.code,
        detectedAt: Date.now(),
        detail: diagnosis.shortReason
      });
    }

    if (
      (diagnosis.isYoutubeFailure || /^youtube/i.test(trackSource)) &&
      diagnosis.isYoutubeFailure &&
      nodeName
    ) {
      this.markYoutubeDegraded(nodeName, diagnosis);
    }

    return diagnosis;
  }

  markYoutubeDegraded(nodeName, diagnosis, customCooldownMs = null) {
    if (!nodeName) return;
    const key = String(nodeName);
    const prev = this.nodeYoutubeHealth.get(key);
    const failCount = (prev?.failCount || 0) + 1;
    const cooldownMs =
      customCooldownMs ?? config.music.youtubeDegradedCooldownMs ?? 10 * 60 * 1000;

    this.nodeYoutubeHealth.set(key, {
      degradedUntil: Date.now() + cooldownMs,
      code: diagnosis?.code || 'YOUTUBE_DEGRADED',
      reason: diagnosis?.shortReason || 'Stream YouTube gagal dimuat',
      failCount
    });

    logger.warn(
      `[YouTubeCircuitBreaker] ⚠️ Sumber YouTube pada node "${key}" ditandai terdegradasi (${diagnosis?.code || 'ERROR'}) selama ${Math.round(
        cooldownMs / 1000
      )}d — memprioritaskan SoundCloud & Bandcamp otomatis.`
    );
  }

  isYoutubeDegraded(nodeName) {
    if (!nodeName) return false;
    const state = this.nodeYoutubeHealth.get(String(nodeName));
    if (!state) return false;
    if (Date.now() >= state.degradedUntil) {
      this.nodeYoutubeHealth.delete(String(nodeName));
      return false;
    }
    return true;
  }

  getYoutubeHealth(nodeName) {
    if (!nodeName) return null;
    if (!this.isYoutubeDegraded(nodeName)) return null;
    return this.nodeYoutubeHealth.get(String(nodeName)) || null;
  }

  clearYoutubeDegraded(nodeName) {
    if (!nodeName) return;
    this.nodeYoutubeHealth.delete(String(nodeName));
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

  isLavalinkDaveBroken(nodeName) {
    if (!nodeName) return false;
    return Boolean(this.nodeDaveStatus.get(String(nodeName))?.daveBroken);
  }

  getNodeDaveStatus(nodeName) {
    if (!nodeName) return null;
    return this.nodeDaveStatus.get(String(nodeName)) || null;
  }

  clearNodeDaveStatus(nodeName) {
    if (!nodeName) return;
    this.nodeDaveStatus.delete(String(nodeName));
  }

  recordNodeAuthStatus(nodeName, status) {
    if (!nodeName) return;
    this.nodeAuthStatus.set(String(nodeName), status);
  }

  getNodeAuthStatus(nodeName) {
    if (!nodeName) return null;
    return this.nodeAuthStatus.get(String(nodeName)) || null;
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
  inspectDaveSupport,
  detectLocalJavaVersion,
  inspectLocalLavalinkConfig,
  classifyTrackFailure,
  summarizeClientExceptions,
  NON_OPUS_YOUTUBE_CLIENTS
};
