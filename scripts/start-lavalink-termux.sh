#!/usr/bin/env bash
# ==========================================================
# Peluncur Pintar Lavalink v4 untuk Android Termux ARM64
# Bot Name : LaguKan
# Developer: 666pallxXx
#
# Fitur:
# 1. Otomatis mengunduh Lavalink v4.2.2 jika belum tersedia.
# 2. Migrasi & upgrade otomatis ~/lavalink/application.yml lama ke snapshot
#    youtube-plugin terbaru + clientOptions anti-403 tanpa membocorkan password/OAuth/poToken.
# 3. Menyiapkan & menjalankan Lavalink di dalam proot-distro Debian ARM64 (glibc)
#    dengan isolasi bersih (unset LD_PRELOAD & TMPDIR Bionic + direktori ekstraksi JNI)
#    agar library native libdave-jvm.so (Discord DAVE E2EE Close 4017 fix),
#    libconnector.so (AAC/Opus/Filter), dan JDA-NAS berjalan 100% kompatibel di ARM64!
# ==========================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAVALINK_DIR="${LAVALINK_DIR:-$HOME/lavalink}"
LAVALINK_JAR="$LAVALINK_DIR/Lavalink.jar"
LAVALINK_CONFIG="$LAVALINK_DIR/application.yml"
LAVALINK_VERSION="${LAVALINK_VERSION:-4.2.2}"
YOUTUBE_PLUGIN_PIN="2be8e542d3f6f178e048dca565892684c2e40177"
DEBIAN_DISTRO="debian"

IS_TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux/files/usr" ]; then
  IS_TERMUX=1
fi

ALLOW_BIONIC=0
SETUP_GLIBC=0
FORCE_UPGRADE_CONFIG=0

for arg in "$@"; do
  case "$arg" in
    --setup-glibc) SETUP_GLIBC=1 ;;
    --allow-bionic) ALLOW_BIONIC=1 ;;
    --upgrade-config) FORCE_UPGRADE_CONFIG=1 ;;
  esac
done

mkdir -p "$LAVALINK_DIR/plugins" "$LAVALINK_DIR/logs" "$LAVALINK_DIR/.natives"
chmod 755 "$LAVALINK_DIR/.natives"

# 1. Unduh Lavalink.jar jika belum ada
if [ ! -f "$LAVALINK_JAR" ]; then
  echo "⬇️  Mengunduh Lavalink v${LAVALINK_VERSION} ke $LAVALINK_JAR ..."
  curl -fL --retry 3 -o "$LAVALINK_JAR" \
    "https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar"
  echo "✅ Lavalink v${LAVALINK_VERSION} berhasil diunduh."
fi

# 2. Buat atau migrasikan application.yml lama ke template terbaru
OLD_YML_BACKUP=""
if [ ! -f "$LAVALINK_CONFIG" ]; then
  cp "$REPO_DIR/config/application.yml.example" "$LAVALINK_CONFIG"
  echo "📝 Menyalin konfigurasi optimal ke $LAVALINK_CONFIG"
elif [ "$FORCE_UPGRADE_CONFIG" -eq 1 ] || { [ "${SKIP_CONFIG_UPGRADE:-0}" != "1" ] && { ! grep -q "$YOUTUBE_PLUGIN_PIN" "$LAVALINK_CONFIG" 2>/dev/null || ! grep -q "clientOptions:" "$LAVALINK_CONFIG" 2>/dev/null; }; }; then
  OLD_YML_BACKUP="${LAVALINK_CONFIG}.bak.$(date +%s)"
  cp "$LAVALINK_CONFIG" "$OLD_YML_BACKUP"
  cp "$REPO_DIR/config/application.yml.example" "$LAVALINK_CONFIG"
  rm -f "$LAVALINK_DIR"/plugins/youtube-plugin-*.jar 2>/dev/null || true
  echo "🔄 Memigrasikan application.yml lama ke snapshot YouTube & DAVE terbaru (backup dibuat)."
fi

# 3. Sinkronkan password dari .env (atau backup application.yml lama) secara aman menggunakan Node.js
if command -v node >/dev/null 2>&1; then
  BOT_ENV_PATH="$REPO_DIR/.env" YML_CFG_PATH="$LAVALINK_CONFIG" OLD_YML_PATH="$OLD_YML_BACKUP" node - <<'EOF'
const fs = require('node:fs');
const envPath = process.env.BOT_ENV_PATH;
const ymlPath = process.env.YML_CFG_PATH;
const oldYmlPath = process.env.OLD_YML_PATH;

function cleanVal(v) {
  let s = String(v || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

if (ymlPath && fs.existsSync(ymlPath)) {
  let targetPassword = '';
  if (envPath && fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of envLines) {
      const m = line.match(/^\s*LAVALINK_PASSWORD\s*=\s*(.*)$/);
      if (m) targetPassword = cleanVal(m[1]);
    }
  }
  if ((!targetPassword || targetPassword === 'masukkan_password_lavalink_anda_di_sini') && oldYmlPath && fs.existsSync(oldYmlPath)) {
    const oldYml = fs.readFileSync(oldYmlPath, 'utf8');
    const oldMatch = oldYml.match(/^\s*password\s*:\s*([^\r\n#]+)/m);
    if (oldMatch) targetPassword = cleanVal(oldMatch[1]);
  }

  if (targetPassword && targetPassword !== 'masukkan_password_lavalink_anda_di_sini') {
    const ymlContent = fs.readFileSync(ymlPath, 'utf8');
    const escaped = targetPassword.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const updated = ymlContent.replace(
      /^(\s*password\s*:\s*).*$/m,
      `$1"${escaped}"`
    );
    if (updated !== ymlContent) {
      fs.writeFileSync(ymlPath, updated, 'utf8');
      console.log('🔐 Password Lavalink berhasil disinkronkan otomatis antara .env dan application.yml.');
    }
  }
}
EOF
fi

# Fungsi instalasi otomatis runtime Debian ARM64 glibc di Termux
setup_termux_glibc() {
  echo "=========================================================="
  echo "🛠️  Menyiapkan Runtime Debian ARM64 (glibc) untuk Lavalink"
  echo "   Diperlukan agar libdave-jvm.so (Discord Voice DAVE E2EE)"
  echo "   dan libconnector.so (AAC/Opus) berjalan 100% di Android ARM64!"
  echo "=========================================================="
  if ! command -v proot-distro >/dev/null 2>&1; then
    pkg update -y
    pkg install -y proot-distro
  fi
  proot-distro install "$DEBIAN_DISTRO" || true
  env -u LD_PRELOAD -u TMPDIR proot-distro login "$DEBIAN_DISTRO" -- bash -c \
    "export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install -y --no-install-recommends openjdk-21-jre-headless ca-certificates libstdc++6 libgcc-s1 curl"
  echo "✅ Runtime Debian ARM64 (glibc + OpenJDK 21 + libstdc++6) siap digunakan!"
}

# 4. Mode --setup-glibc eksplisit
if [ "$SETUP_GLIBC" -eq 1 ]; then
  if [ "$IS_TERMUX" -eq 0 ]; then
    echo "ℹ️  Sistem ini sudah menggunakan Linux standar (bukan Android Bionic). Tidak perlu proot-distro."
    exit 0
  fi
  setup_termux_glibc
  exit 0
fi

# Helper Node.js aman untuk mengaktifkan/menonaktifkan profil glibc (client IOS + bufferDurationMs)
apply_runtime_profile() {
  local profile="$1"
  if command -v node >/dev/null 2>&1; then
    YML_CFG_PATH="$LAVALINK_CONFIG" RUNTIME_PROFILE="$profile" node -e '
      const fs = require("node:fs");
      const p = process.env.YML_CFG_PATH;
      const prof = process.env.RUNTIME_PROFILE;
      if (!p || !fs.existsSync(p)) process.exit(0);
      let yml = fs.readFileSync(p, "utf8");
      if (prof === "glibc") {
        if (!/^\s*-\s*IOS\b/m.test(yml)) {
          yml = yml.replace(/^(\s*-\s*MUSIC\s*)$/m, "$1\n      - IOS");
        }
        if (!/^\s*IOS\s*:/m.test(yml)) {
          yml = yml.replace(/^(\s*clientOptions\s*:\s*)$/m, "$1\n      IOS:\n        searching: false\n        playlistLoading: false");
        }
        yml = yml.replace(/^(\s*bufferDurationMs\s*:\s*)0\b/m, "$1400");
      } else {
        yml = yml.replace(/^\s*-\s*IOS\s*\r?\n/gm, "");
        yml = yml.replace(/^(\s*bufferDurationMs\s*:\s*)400\b/m, "$10");
      }
      fs.writeFileSync(p, yml, "utf8");
    '
  fi
}

# 5. Jalankan Lavalink dengan alokasi RAM efisien untuk perangkat ARM64
JVM_FLAGS="-Xms128M -Xmx512M -XX:+UseG1GC -XX:MaxGCPauseMillis=100 -Djdk.tls.client.protocols=TLSv1.2,TLSv1.3"

if [ "$IS_TERMUX" -eq 1 ]; then
  DEBIAN_ROOTFS="${PREFIX:-/data/data/com.termux/files/usr}/var/lib/proot-distro/installed-rootfs/${DEBIAN_DISTRO}"

  # Jika belum ada Debian glibc dan pengguna tidak memaksa --allow-bionic, siapkan otomatis!
  if [ ! -d "$DEBIAN_ROOTFS" ] && [ "$ALLOW_BIONIC" -eq 0 ]; then
    echo "⚠️  Mendeteksi Android Termux ARM64 tanpa container Debian glibc."
    echo "   Discord mewajibkan protokol enkripsi suara DAVE E2EE (libdave-jvm.so membutuhkan glibc)."
    echo "   Memulai instalasi otomatis runtime Debian ARM64 glibc satu kali..."
    setup_termux_glibc
  fi

  if command -v proot-distro >/dev/null 2>&1 && [ -d "$DEBIAN_ROOTFS" ] && [ "$ALLOW_BIONIC" -eq 0 ]; then
    apply_runtime_profile "glibc"
    echo "🚀 Menjalankan Lavalink di dalam Debian ARM64 (glibc) — DAVE E2EE (libdave-jvm), AAC/Opus JNI, & YouTube IOS/VR aktif!"
    exec env -u LD_PRELOAD -u TMPDIR proot-distro login "$DEBIAN_DISTRO" \
      --bind "$LAVALINK_DIR:/opt/lavalink" \
      -- bash -c "mkdir -p /tmp /opt/lavalink/.natives && chmod 1777 /tmp && cd /opt/lavalink && exec java $JVM_FLAGS -Djava.io.tmpdir=/tmp -Dlava.native.extractPath=/opt/lavalink/.natives -jar Lavalink.jar"
  fi

  apply_runtime_profile "bionic"
  echo "⚠️  PERINGATAN: Lavalink dijalankan pada Java Termux Bionic (--allow-bionic)."
  echo "   Library libdave-jvm.so di Lavalink tidak dapat dimuat di Bionic (Close 4017),"
  echo "   namun LaguKan Node.js memiliki fallback Direct DAVE E2EE (@snazzah/davey-android-arm64)!"
fi

cd "$LAVALINK_DIR"
mkdir -p "$LAVALINK_DIR/.natives"
exec java $JVM_FLAGS -Dlava.native.extractPath="$LAVALINK_DIR/.natives" -jar "$LAVALINK_JAR"
