#!/usr/bin/env bash
# ==========================================================
# Launcher Server Lavalink v4 untuk Android Termux ARM64
# Bot Name : LaguKan
# Developer: 666pallxXx
# Tanpa Root • Tanpa Docker • Tanpa systemd
# ==========================================================

set -e

LAVALINK_DIR="${LAVALINK_DIR:-$HOME/lavalink}"
LAVALINK_VERSION="${LAVALINK_VERSION:-4.2.2}"
LAVALINK_URL="https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" = "--setup-glibc" ]; then
  echo "=========================================================="
  echo "🔧 Menyiapkan Runtime Linux ARM64 (glibc) di Termux"
  echo "   Agar AacDecoderLibrary, OpusDecoder, Filter & libdave"
  echo "   berjalan 100% kompatibel tanpa akses root!"
  echo "=========================================================="
  if ! command -v pkg >/dev/null 2>&1; then
    echo "ℹ️  Perintah --setup-glibc dikhususkan untuk Android Termux."
    exit 0
  fi
  pkg update -y
  pkg install -y proot-distro curl
  if ! proot-distro list 2>/dev/null | grep -q "debian.*installed"; then
    proot-distro install debian
  fi
  proot-distro login debian -- bash -c "apt-get update && apt-get install -y openjdk-21-jre-headless ca-certificates curl"
  echo "=========================================================="
  echo "✅ Runtime Debian ARM64 (glibc + OpenJDK 21) siap!"
  echo "Jalankan Lavalink dengan: ./scripts/start-lavalink-termux.sh"
  echo "=========================================================="
  exit 0
fi

mkdir -p "$LAVALINK_DIR/plugins"

if [ ! -f "$LAVALINK_DIR/Lavalink.jar" ]; then
  echo "⬇️  Mengunduh Lavalink v${LAVALINK_VERSION} ke $LAVALINK_DIR/Lavalink.jar..."
  curl -fL -o "$LAVALINK_DIR/Lavalink.jar" "$LAVALINK_URL"
fi

if [ ! -f "$LAVALINK_DIR/application.yml" ]; then
  echo "📄 Menyalin config/application.yml.example ke $LAVALINK_DIR/application.yml..."
  cp "$REPO_ROOT/config/application.yml.example" "$LAVALINK_DIR/application.yml"
  echo "⚠️  PENTING: Samakan password di $LAVALINK_DIR/application.yml dengan LAVALINK_PASSWORD pada file .env!"
fi

# Bersihkan duplikat youtube-plugin versi lama jika pengguna beralih ke versi snapshot baru
if grep -q "2be8e542d3f6f178e048dca565892684c2e40177" "$LAVALINK_DIR/application.yml" 2>/dev/null; then
  find "$LAVALINK_DIR/plugins" -maxdepth 1 -name "youtube-plugin-1.*.jar" -delete 2>/dev/null || true
fi

echo "=========================================================="
echo "🎵 Menjalankan Server Audio Lavalink untuk LaguKan"
echo "👨‍💻 Developer: 666pallxXx"
echo "📂 Direktori: $LAVALINK_DIR"
echo "=========================================================="

# Gunakan proot-distro Debian ARM64 (glibc) jika tersedia di Termux agar seluruh native library
# (libconnector.so / AacDecoderLibrary / OpusDecoder / libdave-jvm) termuat 100% tanpa error!
if command -v proot-distro >/dev/null 2>&1 && proot-distro list 2>/dev/null | grep -q "debian.*installed"; then
  if proot-distro login debian -- bash -c "command -v java >/dev/null 2>&1"; then
    echo "🟢 Mode Runtime: Termux proot-distro Debian ARM64 (Full Native AAC/Opus/DAVE glibc)"
    exec proot-distro login debian --shared-tmp --bind "$LAVALINK_DIR:/lavalink" -- bash -c "cd /lavalink && exec java -Xms256M -Xmx640M -jar Lavalink.jar"
  fi
fi

echo "🟡 Mode Runtime: Java Standar (Pure-Java Opus Passthrough — pastikan DEFAULT_VOLUME=100)"
echo "💡 Tip Termux: Jalankan './scripts/start-lavalink-termux.sh --setup-glibc' satu kali"
echo "   jika Anda membutuhkan dekode AAC/MP4, pengatur volume bebas, dan libdave penuh."
cd "$LAVALINK_DIR"
exec java -Xms256M -Xmx512M -Djdk.tls.client.protocols=TLSv1.2,TLSv1.3 -jar Lavalink.jar
