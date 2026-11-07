#!/data/data/com.termux/files/usr/bin/bash
# ==========================================================
# Script Instalasi Cepat LaguKan untuk Android Termux
# Bot Name : LaguKan
# Developer: 666pallxXx
# ==========================================================

set -e

echo "=========================================================="
echo "🎵 Memulai Persiapan Lingkungan LaguKan di Android Termux"
echo "👨‍💻 Developer: 666pallxXx"
echo "=========================================================="

echo "[1/4] Memperbarui repositori paket Termux..."
pkg update -y && pkg upgrade -y

echo "[2/4] Menginstal Node.js LTS, Git, OpenJDK 21 (untuk Lavalink), dan Tmux..."
pkg install -y nodejs-lts git openjdk-21 tmux curl

echo "[3/4] Menginstal dependency Node.js project LaguKan..."
npm install

if [ ! -f ".env" ]; then
  echo "[4/4] Menyalin .env.example menjadi .env..."
  cp .env.example .env
  echo "⚠️  Silakan edit file .env menggunakan perintah: nano .env"
else
  echo "[4/4] File .env sudah ada, melewati penyalinan."
fi

echo "=========================================================="
echo "✅ Instalasi dasar selesai!"
echo "Langkah selanjutnya:"
echo "1. Edit konfigurasi  : nano .env"
echo "2. Deploy command    : npm run deploy"
echo "3. Jalankan bot      : npm start"
echo "=========================================================="
