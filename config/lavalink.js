'use strict';

require('dotenv').config({ quiet: true });
const { parseBoolean, parseInteger } = require('./config');

function sanitizeHost(rawHost) {
  const cleaned = String(rawHost || '127.0.0.1')
    .trim()
    .replace(/^(wss?|https?):\/\//i, '')
    .replace(/\/+$/, '');
  // Jika pengguna tak sengaja menyertakan ":port" di LAVALINK_HOST, ambil bagian host-nya saja
  if (cleaned.includes(':') && !cleaned.startsWith('[')) {
    return cleaned.split(':')[0];
  }
  return cleaned || '127.0.0.1';
}

function getLavalinkNodes() {
  const name = (process.env.LAVALINK_NAME || 'LaguKan-Main').trim();
  const host = sanitizeHost(process.env.LAVALINK_HOST || '127.0.0.1');
  const port = parseInteger(process.env.LAVALINK_PORT, 2333, 1, 65535);
  const auth = (process.env.LAVALINK_PASSWORD || '').trim();
  const secure = parseBoolean(process.env.LAVALINK_SECURE, false);

  return [
    {
      name,
      url: `${host}:${port}`,
      host,
      port,
      auth,
      secure
    }
  ];
}

function getShoukakuOptions() {
  return {
    resume: parseBoolean(process.env.LAVALINK_RESUME, true),
    resumeTimeout: parseInteger(process.env.LAVALINK_RESUME_TIMEOUT, 60, 5, 600),
    resumeByLibrary: true,
    reconnectTries: parseInteger(process.env.LAVALINK_RECONNECT_TRIES, 15, 1, 100),
    reconnectInterval: parseInteger(process.env.LAVALINK_RECONNECT_INTERVAL, 5, 1, 120),
    restTimeout: parseInteger(process.env.LAVALINK_REST_TIMEOUT, 45, 5, 180),
    moveOnDisconnect: true,
    voiceConnectionTimeout: parseInteger(process.env.LAVALINK_VOICE_TIMEOUT, 15, 5, 60),
    userAgent: 'LaguKan/1.0.0 (Developer: 666pallxXx)'
  };
}

const lavalinkConfig = {
  nodes: getLavalinkNodes(),
  shoukakuOptions: getShoukakuOptions(),
  healthCheckIntervalMs: parseInteger(process.env.LAVALINK_HEALTH_INTERVAL_MS, 30000, 10000, 300000)
};

function validateLavalinkConfig(cfg = lavalinkConfig) {
  const issues = [];
  for (const node of cfg.nodes) {
    if (!node.auth || node.auth === 'masukkan_password_lavalink_anda_di_sini') {
      issues.push(`LAVALINK_PASSWORD untuk node "${node.name}" belum diatur di file .env.`);
    }
  }
  return {
    valid: issues.length === 0,
    issues
  };
}

module.exports = {
  lavalinkConfig,
  getLavalinkNodes,
  getShoukakuOptions,
  sanitizeHost,
  validateLavalinkConfig
};
