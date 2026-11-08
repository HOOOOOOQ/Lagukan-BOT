'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

function sanitizeSecret(value) {
  let str = String(value ?? '').trim();
  if (
    (str.startsWith('"') && str.endsWith('"') && str.length >= 2) ||
    (str.startsWith("'") && str.endsWith("'") && str.length >= 2)
  ) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const config = {
  bot: {
    name: 'LaguKan',
    developer: '666pallxXx',
    version: '1.0.0',
    token: sanitizeSecret(process.env.DISCORD_TOKEN),
    clientId: sanitizeSecret(process.env.DISCORD_CLIENT_ID),
    guildId: sanitizeSecret(process.env.DISCORD_GUILD_ID),
    autoDeployCommands: parseBoolean(process.env.AUTO_DEPLOY_COMMANDS, false),
    defaultPrefix: '!'
  },

  colors: {
    primary: 0x5865F2,
    playing: 0x1DB954,
    paused: 0xFEE75C,
    queue: 0x00B0F4,
    success: 0x57F287,
    warning: 0xFFA500,
    danger: 0xED4245,
    info: 0x9B59B6
  },

  music: {
    defaultVolume: parseInteger(process.env.DEFAULT_VOLUME, 100, 1, 200),
    maxVolume: parseInteger(process.env.MAX_VOLUME, 200, 100, 500),
    minVolume: 0,
    volumeStep: 10,
    opusPassthroughVolume: 100,
    maxFallbackAttempts: parseInteger(process.env.MAX_FALLBACK_ATTEMPTS, 2, 0, 4),
    trackStartTimeoutMs: parseInteger(process.env.TRACK_START_TIMEOUT_MS, 15000, 3000, 45000),
    maxQueueSize: parseInteger(process.env.MAX_QUEUE_SIZE, 500, 10, 5000),
    maxPlaylistTracks: parseInteger(process.env.MAX_PLAYLIST_TRACKS, 200, 10, 1000),
    defaultSearchSource: ['ytmsearch', 'ytsearch', 'scsearch'].includes(
      (process.env.DEFAULT_SEARCH_SOURCE || '').trim()
    )
      ? process.env.DEFAULT_SEARCH_SOURCE.trim()
      : 'ytmsearch',
    idleTimeoutMs: parseInteger(process.env.IDLE_TIMEOUT_SECONDS, 120, 15, 3600) * 1000,
    playerRefreshIntervalMs: 25000,
    maxHistorySize: 50
  },

  spotify: {
    clientId: (process.env.SPOTIFY_CLIENT_ID || '').trim(),
    clientSecret: (process.env.SPOTIFY_CLIENT_SECRET || '').trim()
  },

  database: {
    path: path.resolve(__dirname, '..', (process.env.DATABASE_PATH || './database/lagukan.sqlite').trim())
  },

  logging: {
    level: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
    toFile: parseBoolean(process.env.LOG_TO_FILE, true),
    filePath: path.resolve(__dirname, '..', (process.env.LOG_FILE_PATH || './logs/lagukan.log').trim()),
    maxFileSizeBytes: 5 * 1024 * 1024
  },

  rateLimit: {
    commandCooldownMs: 1500,
    buttonCooldownMs: 1000
  }
};

/**
 * Memvalidasi konfigurasi wajib sebelum bot login ke Discord.
 * Tidak pernah menampilkan nilai token atau password pada pesan error/log.
 */
function validateConfig(currentConfig = config) {
  const missing = [];
  if (!currentConfig.bot.token || currentConfig.bot.token === 'masukkan_token_bot_discord_anda_di_sini') {
    missing.push('DISCORD_TOKEN');
  }
  if (!currentConfig.bot.clientId || currentConfig.bot.clientId === 'masukkan_application_client_id_anda_di_sini') {
    missing.push('DISCORD_CLIENT_ID');
  }
  return {
    valid: missing.length === 0,
    missing
  };
}

module.exports = {
  config,
  parseBoolean,
  parseInteger,
  sanitizeSecret,
  validateConfig
};
