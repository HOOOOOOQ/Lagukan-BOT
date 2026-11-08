'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const { parseBoolean, parseInteger, sanitizeSecret } = require('./config');

const PLACEHOLDER_PASSWORDS = new Set([
  '',
  'masukkan_password_lavalink_anda_di_sini',
  'GANTI_DENGAN_PASSWORD_KUAT_ANDA',
  'missing_password'
]);

function isPlaceholderPassword(pw) {
  return PLACEHOLDER_PASSWORDS.has(String(pw || '').trim());
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
}

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

/**
 * Membaca password lavalink.server.password dari application.yml lokal secara aman di memori
 * (TIDAK PERNAH dicetak ke log) untuk mencegah kegagalan "Authentication failed GET /v4/websocket"
 * apabila LAVALINK_HOST mengarah ke 127.0.0.1 / localhost.
 */
function readLocalApplicationYmlAuth() {
  const home = os.homedir();
  const repoRoot = path.resolve(__dirname, '..');
  const candidates = [
    process.env.LAVALINK_CONFIG_PATH,
    path.join(repoRoot, 'application.yml'),
    path.resolve(repoRoot, '../lavalink/application.yml'),
    path.join(home, 'lavalink', 'application.yml'),
    path.join(home, 'Lavalink', 'application.yml')
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      let inLavalinkBlock = false;
      let lavalinkIndent = -1;
      let inLavalinkServerBlock = false;
      let serverIndent = -1;
      let extractedPassword = null;
      let extractedPort = null;

      let inTopServerBlock = false;
      let topServerIndent = -1;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indent = line.search(/\S/);

        // Blok top-level "server:" (untuk membaca port)
        if (indent === 0 && /^server\s*:\s*$/.test(trimmed)) {
          inTopServerBlock = true;
          topServerIndent = 0;
          inLavalinkBlock = false;
          inLavalinkServerBlock = false;
          continue;
        }
        if (inTopServerBlock) {
          if (indent <= topServerIndent) {
            inTopServerBlock = false;
          } else {
            const portMatch = trimmed.match(/^port\s*:\s*(\d+)/);
            if (portMatch) extractedPort = Number.parseInt(portMatch[1], 10);
          }
        }

        // Blok "lavalink:" -> "server:" -> "password:"
        if (indent === 0 && /^lavalink\s*:\s*$/.test(trimmed)) {
          inLavalinkBlock = true;
          lavalinkIndent = 0;
          inLavalinkServerBlock = false;
          continue;
        }

        if (inLavalinkBlock) {
          if (indent <= lavalinkIndent) {
            inLavalinkBlock = false;
            inLavalinkServerBlock = false;
            continue;
          }

          if (/^server\s*:\s*$/.test(trimmed)) {
            inLavalinkServerBlock = true;
            serverIndent = indent;
            continue;
          }

          if (inLavalinkServerBlock) {
            if (indent <= serverIndent) {
              inLavalinkServerBlock = false;
            } else {
              const pwMatch = trimmed.match(/^password\s*:\s*(.+)$/);
              if (pwMatch) {
                let rawVal = pwMatch[1].trim();
                // Hapus komentar akhir baris jika nilai tidak diapit kutip
                if (!rawVal.startsWith('"') && !rawVal.startsWith("'")) {
                  rawVal = rawVal.replace(/\s+#.*$/, '').trim();
                }
                extractedPassword = sanitizeSecret(rawVal);
              }
            }
          }
        }
      }

      if (extractedPassword !== null) {
        return {
          found: true,
          filePath,
          locationLabel: `${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`,
          password: extractedPassword,
          port: extractedPort
        };
      }
    } catch {
      // Abaikan jika file tidak dapat dibaca
    }
  }

  return {
    found: false,
    filePath: null,
    locationLabel: null,
    password: null,
    port: null
  };
}

function getLavalinkNodes() {
  const name = sanitizeSecret(process.env.LAVALINK_NAME || 'LaguKan-Main') || 'LaguKan-Main';
  const host = sanitizeHost(process.env.LAVALINK_HOST || '127.0.0.1');
  const port = parseInteger(process.env.LAVALINK_PORT, 2333, 1, 65535);
  const envAuth = sanitizeSecret(process.env.LAVALINK_PASSWORD);
  const secure = parseBoolean(process.env.LAVALINK_SECURE, false);

  let auth = envAuth;
  let authSource = 'env';
  let fallbackLocalAuth = null;
  let passwordMismatch = false;
  let yamlLocation = null;

  if (isLoopbackHost(host)) {
    const localYml = readLocalApplicationYmlAuth();
    if (localYml.found && localYml.password) {
      yamlLocation = localYml.locationLabel;
      if (isPlaceholderPassword(envAuth) && !isPlaceholderPassword(localYml.password)) {
        // .env belum diisi, gunakan password valid dari application.yml lokal secara otomatis
        auth = localYml.password;
        authSource = 'local_yaml_auto';
      } else if (envAuth && localYml.password && envAuth !== localYml.password) {
        // Kedua password berbeda: simpan password application.yml sebagai cadangan otomatis jika HTTP 401 terjadi!
        passwordMismatch = true;
        fallbackLocalAuth = localYml.password;
      }
    }
  }

  return [
    {
      name,
      url: `${host}:${port}`,
      host,
      port,
      auth,
      secure,
      _authSource: authSource,
      _fallbackLocalAuth: fallbackLocalAuth,
      _passwordMismatch: passwordMismatch,
      _yamlLocation: yamlLocation
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
    voiceConnectionTimeout: parseInteger(process.env.LAVALINK_VOICE_TIMEOUT, 20, 5, 60),
    userAgent: 'LaguKan/1.0.0 (Developer: 666pallxXx)'
  };
}

const lavalinkConfig = {
  nodes: getLavalinkNodes(),
  shoukakuOptions: getShoukakuOptions(),
  healthCheckIntervalMs: parseInteger(process.env.LAVALINK_HEALTH_INTERVAL_MS, 15000, 5000, 300000)
};

function validateLavalinkConfig(cfg = lavalinkConfig) {
  const issues = [];
  for (const node of cfg.nodes) {
    if (!node.auth || node.auth === 'masukkan_password_lavalink_anda_di_sini') {
      issues.push(
        `LAVALINK_PASSWORD untuk node "${node.name}" belum diatur di file .env.`
      );
    }
    if (node._authSource === 'local_yaml_auto') {
      issues.push(
        `LAVALINK_PASSWORD di .env masih kosong/placeholder; LaguKan otomatis memakai password dari ${node._yamlLocation}. Segera salin password tersebut ke .env.`
      );
    }
    if (node._passwordMismatch) {
      issues.push(
        `PERINGATAN AUTENTIKASI: LAVALINK_PASSWORD di .env BERBEDA dengan lavalink.server.password di ${node._yamlLocation}! LaguKan menyiapkan auto-fallback lokal, namun segera samakan keduanya agar tidak muncul "Authentication failed GET /v4/websocket".`
      );
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
  isLoopbackHost,
  isPlaceholderPassword,
  readLocalApplicationYmlAuth,
  validateLavalinkConfig
};
