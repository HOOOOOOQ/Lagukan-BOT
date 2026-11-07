'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { config } = require('../../config/config');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  tag: '\x1b[35m'
};

// Pola token bot Discord standar untuk redaksi keamanan otomatis
const DISCORD_TOKEN_REGEX = /[MN][A-Za-z\d]{22,}\.[\w-]{6}\.[\w-]{25,}/g;

function getSensitiveValues() {
  const candidates = [
    process.env.DISCORD_TOKEN,
    process.env.LAVALINK_PASSWORD,
    process.env.SPOTIFY_CLIENT_SECRET,
    config?.bot?.token,
    config?.spotify?.clientSecret
  ];
  return candidates.filter(
    (val) =>
      typeof val === 'string' &&
      val.trim().length >= 6 &&
      !val.startsWith('masukkan_')
  );
}

function redactSecrets(input) {
  if (typeof input !== 'string' || input.length === 0) return String(input ?? '');
  let sanitized = input.replace(DISCORD_TOKEN_REGEX, '[REDACTED_DISCORD_TOKEN]');
  for (const secret of getSensitiveValues()) {
    if (sanitized.includes(secret)) {
      sanitized = sanitized.split(secret).join('[REDACTED_SECRET]');
    }
  }
  return sanitized;
}

function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (meta instanceof Error) {
    return redactSecrets(meta.stack || meta.message);
  }
  if (typeof meta === 'string') {
    return redactSecrets(meta);
  }
  return redactSecrets(util.inspect(meta, { depth: 4, breakLength: 120, compact: true }));
}

function ensureLogDirectory(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > config.logging.maxFileSizeBytes) {
        const rotatedPath = `${filePath}.1`;
        fs.renameSync(filePath, rotatedPath);
      }
    }
  } catch {
    // Jangan hentikan aplikasi apabila sistem file sedang read-only
  }
}

function writeLog(level, scope, message, meta) {
  const configuredLevel = LEVELS[config.logging.level] ?? LEVELS.info;
  const currentLevel = LEVELS[level] ?? LEVELS.info;
  if (currentLevel < configuredLevel) return;

  const timestamp = new Date().toISOString();
  const safeMessage = redactSecrets(String(message));
  const safeScope = scope ? `[${scope}]` : '[LaguKan]';
  const metaText = formatMeta(meta);
  const fullPlain = `${timestamp} [${level.toUpperCase()}] ${safeScope} ${safeMessage}${metaText ? ` | ${metaText}` : ''}`;

  const color = COLORS[level] || COLORS.info;
  const coloredLine =
    `${COLORS.dim}${timestamp}${COLORS.reset} ` +
    `${color}${level.toUpperCase().padEnd(5)}${COLORS.reset} ` +
    `${COLORS.tag}${safeScope}${COLORS.reset} ` +
    `${safeMessage}` +
    (metaText ? ` ${COLORS.dim}${metaText}${COLORS.reset}` : '');

  if (level === 'error') {
    console.error(coloredLine);
  } else if (level === 'warn') {
    console.warn(coloredLine);
  } else {
    console.log(coloredLine);
  }

  if (config.logging.toFile && config.logging.filePath) {
    try {
      ensureLogDirectory(config.logging.filePath);
      fs.appendFileSync(config.logging.filePath, `${fullPlain}\n`, 'utf8');
    } catch {
      // Abaikan kegagalan penulisan log file agar bot tetap stabil
    }
  }
}

function createScopedLogger(scope) {
  return {
    debug: (msg, meta) => writeLog('debug', scope, msg, meta),
    info: (msg, meta) => writeLog('info', scope, msg, meta),
    warn: (msg, meta) => writeLog('warn', scope, msg, meta),
    error: (msg, meta) => writeLog('error', scope, msg, meta)
  };
}

const logger = {
  debug: (msg, meta) => writeLog('debug', 'LaguKan', msg, meta),
  info: (msg, meta) => writeLog('info', 'LaguKan', msg, meta),
  warn: (msg, meta) => writeLog('warn', 'LaguKan', msg, meta),
  error: (msg, meta) => writeLog('error', 'LaguKan', msg, meta),
  child: createScopedLogger,
  redactSecrets
};

module.exports = logger;
