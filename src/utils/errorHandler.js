'use strict';

const { MessageFlags } = require('discord.js');
const logger = require('./logger');
const { buildErrorEmbed, buildWarningEmbed } = require('./embeds');

const ErrorCodes = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_SOURCE',
  TRACK_NOT_FOUND: 'TRACK_NOT_FOUND',
  EMPTY_QUEUE: 'EMPTY_QUEUE',
  USER_NOT_IN_VOICE: 'USER_NOT_IN_VOICE',
  DIFFERENT_VOICE_CHANNEL: 'DIFFERENT_VOICE_CHANNEL',
  BOT_MISSING_PERMISSIONS: 'BOT_MISSING_PERMISSIONS',
  VOICE_CONNECTION_FAILED: 'VOICE_CONNECTION_FAILED',
  LAVALINK_OFFLINE: 'LAVALINK_OFFLINE',
  LAVALINK_AUTH_FAILED: 'LAVALINK_AUTH_FAILED',
  TRACK_PLAYBACK_FAILED: 'TRACK_PLAYBACK_FAILED',
  DISCORD_API_ERROR: 'DISCORD_API_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERACTION_EXPIRED: 'INTERACTION_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  MUSIC_CHANNEL_RESTRICTED: 'MUSIC_CHANNEL_RESTRICTED',
  VALIDATION_ERROR: 'VALIDATION_ERROR'
});

class AppError extends Error {
  constructor(code, userMessage, options = {}) {
    super(userMessage);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.title = options.title || null;
    this.isWarning = Boolean(options.isWarning);
    this.cause = options.cause;
  }
}

const DEFAULT_TITLES = {
  [ErrorCodes.INVALID_URL]: 'URL Tidak Valid',
  [ErrorCodes.UNSUPPORTED_SOURCE]: 'Sumber Musik Tidak Didukung',
  [ErrorCodes.TRACK_NOT_FOUND]: 'Lagu Tidak Ditemukan',
  [ErrorCodes.EMPTY_QUEUE]: 'Antrean Kosong',
  [ErrorCodes.USER_NOT_IN_VOICE]: 'Belum Berada di Voice Channel',
  [ErrorCodes.DIFFERENT_VOICE_CHANNEL]: 'Voice Channel Berbeda',
  [ErrorCodes.BOT_MISSING_PERMISSIONS]: 'Izin Bot Tidak Mencukupi',
  [ErrorCodes.VOICE_CONNECTION_FAILED]: 'Gagal Terhubung ke Voice Channel',
  [ErrorCodes.LAVALINK_OFFLINE]: 'Server Audio Lavalink Offline',
  [ErrorCodes.LAVALINK_AUTH_FAILED]: 'Autentikasi Lavalink Gagal',
  [ErrorCodes.TRACK_PLAYBACK_FAILED]: 'Gagal Memutar Lagu',
  [ErrorCodes.DISCORD_API_ERROR]: 'Kesalahan Discord API',
  [ErrorCodes.DATABASE_ERROR]: 'Kesalahan Database',
  [ErrorCodes.INTERACTION_EXPIRED]: 'Interaksi Kedaluwarsa',
  [ErrorCodes.RATE_LIMITED]: 'Terlalu Cepat (Rate Limit)',
  [ErrorCodes.PERMISSION_DENIED]: 'Akses Ditolak (DJ Mode / Izin)',
  [ErrorCodes.MUSIC_CHANNEL_RESTRICTED]: 'Channel Khusus Musik',
  [ErrorCodes.VALIDATION_ERROR]: 'Input Tidak Valid'
};

/**
 * Mengklasifikasikan objek error mentah menjadi informasi terstruktur untuk pengguna & log.
 */
function classifyError(err) {
  if (err instanceof AppError) {
    return {
      code: err.code,
      title: err.title || DEFAULT_TITLES[err.code] || 'Terjadi Kesalahan',
      message: err.userMessage,
      isWarning: err.isWarning,
      expected: true
    };
  }

  const rawMsg = String(err?.message || err || '');
  const discordCode = err?.code;

  // Discord Interaction Expired / Unknown Interaction / Already Acknowledged
  if (discordCode === 10062 || discordCode === 40060 || /Unknown interaction/i.test(rawMsg)) {
    return {
      code: ErrorCodes.INTERACTION_EXPIRED,
      title: DEFAULT_TITLES[ErrorCodes.INTERACTION_EXPIRED],
      message: 'Interaksi ini telah kedaluwarsa. Silakan jalankan kembali perintah Anda.',
      isWarning: true,
      expected: true
    };
  }

  // Discord Missing Permissions / Access
  if (discordCode === 50013 || discordCode === 50001 || /Missing Permissions|Missing Access/i.test(rawMsg)) {
    return {
      code: ErrorCodes.BOT_MISSING_PERMISSIONS,
      title: DEFAULT_TITLES[ErrorCodes.BOT_MISSING_PERMISSIONS],
      message: 'LaguKan tidak memiliki izin Discord yang diperlukan untuk menjalankan aksi tersebut.',
      isWarning: false,
      expected: true
    };
  }

  // Rate Limit
  if (err?.status === 429 || /rate limit/i.test(rawMsg)) {
    return {
      code: ErrorCodes.RATE_LIMITED,
      title: DEFAULT_TITLES[ErrorCodes.RATE_LIMITED],
      message: 'Permintaan sedang dibatasi sementara (Rate Limit). Tunggu beberapa detik lalu coba lagi.',
      isWarning: true,
      expected: true
    };
  }

  // Lavalink Auth Failed (HTTP 401 / 403)
  if (err?.status === 401 || err?.status === 403 || /401|Unauthorized|Forbidden/i.test(rawMsg)) {
    return {
      code: ErrorCodes.LAVALINK_AUTH_FAILED,
      title: DEFAULT_TITLES[ErrorCodes.LAVALINK_AUTH_FAILED],
      message: 'Autentikasi ke server Lavalink gagal. Periksa kecocokan `LAVALINK_PASSWORD` pada file `.env` dan `application.yml`.',
      isWarning: false,
      expected: false
    };
  }

  // Lavalink Offline / Network Refused
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|No available.*node|Lavalink/i.test(rawMsg)) {
    return {
      code: ErrorCodes.LAVALINK_OFFLINE,
      title: DEFAULT_TITLES[ErrorCodes.LAVALINK_OFFLINE],
      message: 'Server audio Lavalink sedang tidak terjangkau atau belum menyala. Pastikan proses Java Lavalink aktif.',
      isWarning: false,
      expected: false
    };
  }

  // Voice Connection Timeout
  if (/voice connection.*timeout|session.*missing|VoiceConnection/i.test(rawMsg)) {
    return {
      code: ErrorCodes.VOICE_CONNECTION_FAILED,
      title: DEFAULT_TITLES[ErrorCodes.VOICE_CONNECTION_FAILED],
      message: 'Gagal membangun koneksi suara ke Discord. Pastikan izin voice channel aktif dan jaringan stabil.',
      isWarning: false,
      expected: false
    };
  }

  // SQLite / Database
  if (/SQLITE|sql\.js|database/i.test(rawMsg)) {
    return {
      code: ErrorCodes.DATABASE_ERROR,
      title: DEFAULT_TITLES[ErrorCodes.DATABASE_ERROR],
      message: 'Terjadi gangguan pada penyimpanan database lokal. Silakan coba sesaat lagi.',
      isWarning: false,
      expected: false
    };
  }

  // Discord API Error lainnya
  if (err?.name === 'DiscordAPIError' || typeof discordCode === 'number') {
    return {
      code: ErrorCodes.DISCORD_API_ERROR,
      title: DEFAULT_TITLES[ErrorCodes.DISCORD_API_ERROR],
      message: 'Terjadi kendala komunikasi dengan Discord API. Silakan ulangi beberapa saat lagi.',
      isWarning: false,
      expected: false
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    title: 'Terjadi Kesalahan Sistem',
    message: 'Maaf, terjadi kesalahan tak terduga saat memproses permintaan Anda. Masalah telah dicatat ke log.',
    isWarning: false,
    expected: false
  };
}

/**
 * Mengirim atau memperbarui respons interaksi Discord secara aman tanpa melempar exception.
 */
async function safeReply(interaction, payload, ephemeral = false) {
  if (!interaction) return null;
  const finalPayload = { ...payload };

  if (ephemeral && !interaction.deferred && !interaction.replied) {
    finalPayload.flags = MessageFlags.Ephemeral;
  }

  try {
    if (interaction.deferred && !interaction.replied) {
      const { flags: _ignored, ...editPayload } = finalPayload;
      return await interaction.editReply(editPayload);
    }
    if (interaction.replied) {
      if (ephemeral) finalPayload.flags = MessageFlags.Ephemeral;
      return await interaction.followUp(finalPayload);
    }
    return await interaction.reply(finalPayload);
  } catch (err) {
    if (err?.code !== 10062 && err?.code !== 40060) {
      logger.warn('Gagal mengirim respons interaksi Discord', err);
    }
    return null;
  }
}

/**
 * Menangani seluruh error yang terjadi di dalam command / button / select menu.
 */
async function handleInteractionError(interaction, error, context = 'Interaction') {
  const classified = classifyError(error);

  if (classified.code === ErrorCodes.INTERACTION_EXPIRED) {
    logger.debug(`Interaksi kedaluwarsa pada ${context}`);
    return;
  }

  if (classified.expected) {
    logger.debug(`[${context}] ${classified.code}: ${classified.message}`);
  } else {
    logger.error(`[${context}] ${classified.code}: ${error?.message || error}`, error);
  }

  const embed = classified.isWarning
    ? buildWarningEmbed(classified.title, classified.message)
    : buildErrorEmbed(classified.title, classified.message);

  await safeReply(interaction, { embeds: [embed], components: [] }, true);
}

module.exports = {
  ErrorCodes,
  AppError,
  classifyError,
  safeReply,
  handleInteractionError
};
