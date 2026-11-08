#!/data/data/com.termux/files/usr/bin/bash
# ==========================================================
# Script Instalasi Cepat LaguKan untuk Android Termux ARM64
# Bot Name : LaguKan
# Developer: 666pallxXx
# ==========================================================

set -e

echo "=========================================================="
echo "🎵 Memulai Persiapan Lingkungan LaguKan di Android Termux"
echo "👨‍💻 Developer: 666pallxXx"
echo "=========================================================="

echo "[1/5] Memperbarui repositori paket Termux..."
pkg update -y && pkg upgrade -y

echo "[2/5] Menginstal Node.js LTS, Git, OpenJDK 21, proot-distro, FFmpeg ARM64, Tmux, dan Curl..."
pkg install -y nodejs-lts git openjdk-21 proot-distro ffmpeg tmux curl

echo "[3/5] Menginstal dependency Node.js project LaguKan (kompatibel penuh ARM64)..."
npm install

if [ ! -f ".env" ]; then
  echo "[4/5] Menyalin .env.example menjadi .env..."
  cp .env.example .env
  echo "⚠️  Silakan edit file .env menggunakan perintah: nano .env"
else
  echo "[4/5] File .env sudah ada, melewati penyalinan."
fi

chmod +x scripts/start-lavalink-termux.sh 2>/dev/null || true

echo "[5/5] Informasi Server Audio Lavalink (Proses Java Terpisah):"
echo "   Untuk dukungan penuh enkripsi suara Discord DAVE E2EE (libdave-jvm) & decoder ARM64:"
echo "   1. ./scripts/start-lavalink-termux.sh --setup-glibc"
echo "   2. ./scripts/start-lavalink-termux.sh"

echo "=========================================================="
echo "✅ Instalasi dasar selesai!"
echo "Langkah selanjutnya:"
echo "1. Edit konfigurasi bot      : nano .env"
echo "2. Siapkan runtime Lavalink  : ./scripts/start-lavalink-termux.sh --setup-glibc"
echo "3. Jalankan server Lavalink  : ./scripts/start-lavalink-termux.sh (di sesi tmux 1)"
echo "4. Deploy Slash Command      : npm run deploy"
echo "5. Jalankan LaguKan Bot      : npm start (di sesi tmux 2)"
echo "=========================================================="
