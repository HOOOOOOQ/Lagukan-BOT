#!/usr/bin/env bash
# ==============================================================================
# LaguKan — Peluncur Server Lavalink v4 untuk Android Termux ARM64 (glibc)
# Developer: 666pallxXx
#
# Mengapa skrip ini sangat krusial di Android Termux?
# 1. Mencegah error "Authentication failed from /127.0.0.1 GET /v4/websocket":
#    Menyinkronkan otomatis LAVALINK_PASSWORD (.env) <-> lavalink.server.password
#    (application.yml) tanpa pernah menampilkan password ke layar log.
# 2. Mencegah bug "Bot masuk Voice Channel tetapi TIDAK ADA SUARA":
#    Lavalink v4.2+ membutuhkan library native glibc "libdave-jvm.so" (Discord
#    Voice v8 DAVE E2EE) serta "libconnector.so" (Opus/AAC DSP). Binary OpenJDK
#    bawaan Termux memakai Android Bionic libc sehingga gagal memuat JNI glibc
#    dan membuat transport suara UDP gagal diam-diam (state.connected = false).
#    Skrip ini otomatis menyiapkan container ringan Debian ARM64 (proot-distro)
#    yang berbagi jaringan localhost (127.0.0.1:2333) secara langsung dengan bot.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${BOT_DIR}/.env"

LAVALINK_DIR="${LAVALINK_DIR:-$HOME/lavalink}"
LAVALINK_JAR="${LAVALINK_JAR:-$LAVALINK_DIR/Lavalink.jar}"
LAVALINK_CONFIG="${LAVALINK_CONFIG:-$LAVALINK_DIR/application.yml}"
DISTRO_NAME="${LAVALINK_PROOT_DISTRO:-debian}"
JAVA_HEAP_MAX="${JAVA_HEAP_MAX:-768M}"
JAVA_HEAP_MIN="${JAVA_HEAP_MIN:-256M}"
LAVALINK_VERSION="${LAVALINK_VERSION:-4.2.2}"

mkdir -p "$LAVALINK_DIR"

if [ ! -f "$LAVALINK_CONFIG" ]; then
  if [ -f "${BOT_DIR}/config/application.yml.example" ]; then
    echo "[LaguKan] Menyalin template konfigurasi ke $LAVALINK_CONFIG ..."
    cp "${BOT_DIR}/config/application.yml.example" "$LAVALINK_CONFIG"
  else
    echo "[ERROR] File konfigurasi tidak ditemukan di: $LAVALINK_CONFIG"
    exit 1
  fi
fi

# ------------------------------------------------------------------------------
# TAHAP 1: Sinkronisasi otomatis password antara .env dan application.yml
#          (Menggunakan Node.js agar karakter khusus aman & tidak bocor ke log)
# ------------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  BOT_ENV_PATH="$ENV_FILE" YML_CFG_PATH="$LAVALINK_CONFIG" node - <<'EOF'
const fs = require('node:fs');
const crypto = require('node:crypto');

const envPath = process.env.BOT_ENV_PATH;
const ymlPath = process.env.YML_CFG_PATH;

const PLACEHOLDERS = new Set([
  '',
  'masukkan_password_lavalink_anda_di_sini',
  'GANTI_DENGAN_PASSWORD_KUAT_ANDA',
  'missing_password'
]);

function cleanSecret(val) {
  let s = String(val ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
let ymlContent = fs.existsSync(ymlPath) ? fs.readFileSync(ymlPath, 'utf8') : '';

let envPw = '';
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^\s*LAVALINK_PASSWORD\s*=\s*(.*)\s*$/);
  if (m) {
    let raw = m[1].trim();
    if (!raw.startsWith('"') && !raw.startsWith("'")) {
      raw = raw.replace(/\s+#.*$/, '').trim();
    }
    envPw = cleanSecret(raw);
    break;
  }
}

let ymlPw = '';
{
  const lines = ymlContent.split(/\r?\n/);
  let inLavalink = false;
  let inServer = false;
  let serverIndent = -1;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = line.search(/\S/);
    if (indent === 0 && /^lavalink\s*:\s*$/.test(t)) {
      inLavalink = true;
      inServer = false;
      continue;
    }
    if (inLavalink && indent === 0) {
      inLavalink = false;
      inServer = false;
    }
    if (inLavalink && /^server\s*:\s*$/.test(t)) {
      inServer = true;
      serverIndent = indent;
      continue;
    }
    if (inServer) {
      if (indent <= serverIndent) {
        inServer = false;
      } else {
        const pm = t.match(/^password\s*:\s*(.+)$/);
        if (pm) {
          let raw = pm[1].trim();
          if (!raw.startsWith('"') && !raw.startsWith("'")) {
            raw = raw.replace(/\s+#.*$/, '').trim();
          }
          ymlPw = cleanSecret(raw);
          break;
        }
      }
    }
  }
}

function updateYmlPassword(content, newPw) {
  const lines = content.split(/\r?\n/);
  let inLavalink = false;
  let inServer = false;
  let serverIndent = -1;
  let replaced = false;
  const escaped = newPw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const indent = lines[i].search(/\S/);
    if (indent === 0 && /^lavalink\s*:\s*$/.test(t)) {
      inLavalink = true;
      inServer = false;
      continue;
    }
    if (inLavalink && indent === 0) {
      inLavalink = false;
      inServer = false;
    }
    if (inLavalink && /^server\s*:\s*$/.test(t)) {
      inServer = true;
      serverIndent = indent;
      continue;
    }
    if (inServer) {
      if (indent <= serverIndent) {
        inServer = false;
      } else if (/^password\s*:/.test(t) && !replaced) {
        const pad = ' '.repeat(indent);
        lines[i] = `${pad}password: "${escaped}"`;
        replaced = true;
        break;
      }
    }
  }
  return replaced ? lines.join('\n') : content;
}

function updateEnvPassword(content, newPw) {
  const lines = content.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*LAVALINK_PASSWORD\s*=/.test(lines[i])) {
      lines[i] = `LAVALINK_PASSWORD=${newPw}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    lines.push(`LAVALINK_PASSWORD=${newPw}`);
  }
  return lines.join('\n');
}

const envIsPlaceholder = PLACEHOLDERS.has(envPw);
const ymlIsPlaceholder = PLACEHOLDERS.has(ymlPw);

if (!envIsPlaceholder && envPw !== ymlPw) {
  fs.writeFileSync(ymlPath, updateYmlPassword(ymlContent, envPw), 'utf8');
  console.log('[LaguKan] ✅ Password Lavalink di application.yml berhasil disinkronkan otomatis dengan .env!');
} else if (envIsPlaceholder && !ymlIsPlaceholder && fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, updateEnvPassword(envContent, ymlPw), 'utf8');
  console.log('[LaguKan] ✅ LAVALINK_PASSWORD di .env berhasil disinkronkan otomatis dengan application.yml!');
} else if (envIsPlaceholder && ymlIsPlaceholder) {
  const generated = 'LaguKan_' + crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(ymlPath, updateYmlPassword(ymlContent, generated), 'utf8');
  if (fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, updateEnvPassword(envContent, generated), 'utf8');
  }
  console.log('[LaguKan] ✅ Password Lavalink aman dibuat otomatis dan disinkronkan ke .env & application.yml!');
} else {
  console.log('[LaguKan] ✅ Autentikasi password .env dan application.yml sudah cocok.');
}
EOF
fi

# ------------------------------------------------------------------------------
# TAHAP 2: Pastikan Lavalink.jar tersedia
# ------------------------------------------------------------------------------
if [ ! -f "$LAVALINK_JAR" ]; then
  echo "[LaguKan] Lavalink.jar belum ditemukan di $LAVALINK_JAR. Mengunduh Lavalink v${LAVALINK_VERSION}..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL -o "$LAVALINK_JAR" \
      "https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$LAVALINK_JAR" \
      "https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar"
  else
    echo "[ERROR] curl/wget tidak ditemukan. Unduh Lavalink.jar ke $LAVALINK_JAR terlebih dahulu."
    exit 1
  fi
fi

# ------------------------------------------------------------------------------
# TAHAP 3: Di Android Termux ARM64, wajibkan runtime glibc (proot-distro Debian)
#          agar libdave-jvm.so (Discord Voice v8 E2EE) & UDP transport aktif!
# ------------------------------------------------------------------------------
IS_TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux/files/usr" ]; then
  IS_TERMUX=1
fi

if [ "$IS_TERMUX" -eq 1 ] && ! command -v proot-distro >/dev/null 2>&1; then
  if command -v pkg >/dev/null 2>&1; then
    echo "[LaguKan] Menginstal paket Termux 'proot-distro' untuk dukungan penuh Discord Voice DAVE E2EE & UDP..."
    pkg update -y && pkg install -y proot-distro
  fi
fi

if command -v proot-distro >/dev/null 2>&1; then
  echo "[LaguKan] Memeriksa lingkungan runtime glibc ($DISTRO_NAME) via proot-distro..."

  if ! proot-distro login "$DISTRO_NAME" -- true >/dev/null 2>&1; then
    echo "[LaguKan] Menginstal container ringan '$DISTRO_NAME' (hanya dilakukan 1x pada penggunaan pertama)..."
    proot-distro install "$DISTRO_NAME"
  fi

  if ! proot-distro login "$DISTRO_NAME" -- command -v java >/dev/null 2>&1; then
    echo "[LaguKan] Menginstal OpenJDK 21 Headless (glibc ARM64) & sertifikat TLS di '$DISTRO_NAME'..."
    proot-distro login "$DISTRO_NAME" -- bash -c \
      "export DEBIAN_FRONTEND=noninteractive && apt-get update -y && (apt-get install -y --no-install-recommends openjdk-21-jre-headless ca-certificates || apt-get install -y --no-install-recommends default-jre-headless ca-certificates) && apt-get clean"
  fi

  echo "[LaguKan] Menjalankan Lavalink v4 di dalam runtime glibc ARM64 (libdave-jvm + libconnector + UDP siap)..."
  exec proot-distro login "$DISTRO_NAME" \
    --bind "$LAVALINK_DIR:/opt/lavalink" \
    -- bash -c "cd /opt/lavalink && exec java -Xms${JAVA_HEAP_MIN} -Xmx${JAVA_HEAP_MAX} -XX:+UseG1GC -Djdk.tls.client.protocols=TLSv1.2,TLSv1.3 -jar /opt/lavalink/Lavalink.jar"
fi

echo "[PERINGATAN] 'proot-distro' tidak tersedia — menjalankan Lavalink langsung menggunakan Java sistem."
if [ "$IS_TERMUX" -eq 1 ]; then
  echo "[PERINGATAN KRITIS] Di Android Termux tanpa proot-distro (glibc), libdave-jvm.so mungkin gagal dimuat sehingga Discord Voice tidak mengeluarkan suara! Instal dengan: pkg install proot-distro -y"
fi
cd "$LAVALINK_DIR"
exec java -Xms"${JAVA_HEAP_MIN}" -Xmx"${JAVA_HEAP_MAX}" -XX:+UseG1GC -jar "$LAVALINK_JAR"
