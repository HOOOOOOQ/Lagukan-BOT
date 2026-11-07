# 🎵 LaguKan — Discord Music Bot

> **Bot Name:** `LaguKan`  
> **Developer:** `666pallxXx`  
> **Runtime:** Node.js (`>= 20.0.0`) • Discord.js v14 • `@discordjs/voice` • Lavalink v4 (`Shoukaku`) • SQLite (`sql.js`)  
> **Target Utama:** Android Termux & Linux Ringan  
> **Bahasa Antarmuka:** Bahasa Indonesia

**LaguKan** adalah Discord Music Bot modern bergaya *Jockie Music* yang dirancang dengan arsitektur modular, ringan, tahan gangguan, dan **100% kompatibel dijalankan langsung di Android Termux** tanpa membutuhkan kompilasi C++ (`node-gyp`) maupun Docker.

Cukup bergabung ke **Voice Channel** mana saja di server Discord Anda, ketik `/play [judul lagu atau URL]`, dan **LaguKan** akan otomatis mendeteksi voice channel Anda, masuk, memutar musik berkualitas tinggi melalui **Lavalink**, serta menampilkan **Interactive Music Player** lengkap dengan 10 tombol kontrol langsung di text channel!

---

## ✨ Fitur Unggulan

- **Auto Voice Detection & Auto Join:** Tidak perlu memasukkan ID Voice Channel secara manual. Bot otomatis mengenali voice channel pemanggil `/play`.
- **Dukungan Multi-Source Jujur & Akurat:**
  - **YouTube** (Video, Shorts, & Playlist)
  - **YouTube Music** (Lagu & Playlist)
  - **Spotify** (Track, Album, Playlist, & Top Artist — *membaca metadata resmi/publik Spotify lalu mencocokkannya secara otomatis dengan sumber audio yang tersedia di Lavalink; bukan mengklaim streaming DRM langsung dari Spotify*)
  - **SoundCloud** (Track & Set/Playlist melalui Lavalink)
  - **Direct Audio URL** (`.mp3`, `.flac`, `.ogg`, `.wav`, `.m4a`, `.opus`, `.m3u8`)
  - **Pencarian Cerdas** berdasarkan judul lagu & nama artis
- **Interactive Embed Music Player (10 Tombol Aktif):**
  - Baris 1: `⏮ Previous` • `⏸ Pause` • `▶ Resume` • `⏭ Skip` • `⏹ Stop`
  - Baris 2: `🔀 Shuffle` • `🔁 Loop` • `🔉 Volume -` • `🔊 Volume +` • `📜 Queue`
- **Queue Manager Terisolasi per Server:** Setiap Discord Guild memiliki antrean, riwayat lagu (`previous`), mode loop (`off` / `track` / `queue`), filter audio, dan status pemutar sendiri yang tidak pernah bercampur antar-server.
- **Voice State Monitoring & Pemulihan Otomatis:**
  - Keluar otomatis saat antrean habis atau saat seluruh pendengar meninggalkan voice channel (hemat baterai & kuota di Termux).
  - Mode **24/7** persisten yang tersimpan di SQLite dan otomatis menyambung kembali saat bot maupun Lavalink menyala ulang.
  - Menolak perpindahan channel sembarangan apabila bot sedang aktif digunakan di voice channel lain.
- **Database SQLite Tahan Restart (`sql.js` WebAssembly):**
  - Menyimpan Volume Default, DJ Mode, Role DJ, Music Channel, Mode 24/7, Autoplay, dan Saved Playlists ke `./database/lagukan.sqlite` secara atomik tanpa error kompilasi native di Android ARM64.
- **Sistem DJ Mode & Permission Berlapis:** Mengatur hak akses Administrator, Role DJ, Requester (peminta lagu), dan pendengar biasa baik pada Slash Command maupun tombol player.

---

## 📂 Struktur Direktori Project

```text
LaguKan/
├── index.js                         # Entry point utama & graceful shutdown
├── package.json                     # Konfigurasi paket & dependency project
├── .env.example                     # Contoh file variabel environment (.env)
├── .gitignore                       # Proteksi file sensitif (.env, sqlite, log)
├── README.md                        # Dokumentasi lengkap instalasi & penggunaan
├── config/
│   ├── config.js                    # Konfigurasi aplikasi, batas antrean, & validasi
│   ├── lavalink.js                  # Konfigurasi koneksi node Lavalink & Shoukaku
│   └── application.yml.example      # Template konfigurasi server Java Lavalink v4
├── src/
│   ├── client.js                    # Kelas utama LaguKanClient
│   ├── events/
│   │   ├── ready.js                 # Penanganan saat bot siap & set status
│   │   ├── interactionCreate.js     # Router Slash Command, Tombol, & Autocomplete
│   │   ├── voiceStateUpdate.js      # Pemantauan koneksi voice, idle, & auto-reconnect 24/7
│   │   └── playerEvents.js          # Event node Lavalink & Node Health Monitor
│   ├── commands/
│   │   ├── playback/                # play, search, pause, resume, skip, stop, previous, seek, volume, nowplaying
│   │   ├── queue/                   # queue, shuffle, loop, remove, clear, move, jump, replay
│   │   ├── voice/                   # join, disconnect, 247, autoplay
│   │   ├── utility/                 # lyrics, filter, playlist, saveplaylist, loadplaylist, dj
│   │   └── information/             # help, ping, botinfo, serverinfo, stats
│   ├── music/
│   │   ├── playerManager.js         # Manajer sesi pemutar musik per-guild & pemulihan
│   │   ├── queueManager.js          # Manajer antrean & riwayat lagu per-guild
│   │   ├── sourceResolver.js        # Multi-source resolver & pencocokan metadata Spotify
│   │   ├── musicPlayer.js           # Kontroler Shoukaku Player, filter, & sinkronisasi Embed
│   │   ├── autoplay.js              # Mesin rekomendasi lagu otomatis anti-duplikat
│   │   └── filters.js               # Preset efek filter audio Lavalink v4
│   ├── buttons/
│   │   └── playerButtons.js         # Handler 10 tombol interaktif Music Player & navigasi Queue
│   ├── database/
│   │   ├── database.js              # Engine SQLite berbasis sql.js dengan penyimpanan atomik
│   │   ├── schema.js                # Skema tabel SQLite
│   │   ├── guildRepository.js       # Penyimpanan pengaturan per-server
│   │   └── playlistRepository.js    # Penyimpanan playlist pengguna & publik
│   ├── handlers/
│   │   ├── commandHandler.js        # Pemuat otomatis Slash Commands
│   │   ├── eventHandler.js          # Pemuat otomatis Events
│   │   └── deployCommands.js        # Pendaftar Slash Commands ke Discord REST API
│   └── utils/
│       ├── logger.js                # Logger berwarna + file rotasi + redaksi token otomatis
│       ├── embeds.js                # Pembuat Embed & komponen tombol interaktif
│       ├── formatters.js            # Formatter durasi, progress bar, & parser waktu
│       ├── permissions.js           # Validasi Voice Channel, Izin Bot, & DJ Mode
│       ├── errorHandler.js          # Penanganan terpusat seluruh jenis error
│       └── rateLimiter.js           # Pembatas anti-spam per pengguna
├── database/                        # Lokasi file database SQLite (lagukan.sqlite)
├── logs/                            # Lokasi file log runtime (lagukan.log)
├── scripts/
│   ├── checkSyntax.js               # Pemeriksa syntax & validasi seluruh modul
│   └── termux-setup.sh              # Script bantu instalasi cepat Android Termux
└── tests/                           # Pengujian otomatis unit & integrasi (node --test)
```

---

## 📋 Daftar Lengkap Slash Commands (33 Perintah)

| Kategori | Perintah | Fungsi |
| :--- | :--- | :--- |
| **Playback** | `/play [lagu]` | Otomatis masuk ke voice channel Anda & memutar lagu/playlist dari judul atau URL |
| | `/search [kata_kunci] [sumber]` | Mencari hingga 10 lagu dan memilih lewat menu dropdown interaktif |
| | `/pause` | Menjeda lagu yang sedang diputar |
| | `/resume` | Melanjutkan lagu yang sedang dijeda |
| | `/skip` | Melewati lagu saat ini ke lagu berikutnya di antrean |
| | `/stop` | Menghentikan musik, mengosongkan antrean, & keluar (kecuali 24/7 aktif) |
| | `/previous` | Memutar kembali lagu sebelumnya dari riwayat sesi |
| | `/seek [waktu]` | Melompat ke detik/menit tertentu (contoh: `90`, `1:30`, `2m15s`) |
| | `/volume [level] [simpan_default]` | Melihat atau mengatur volume `0% - 200%` serta menyimpan default server |
| | `/nowplaying` | Menampilkan detail lagu aktif & memunculkan kembali panel kontrol interaktif |
| **Queue** | `/queue [halaman]` | Menampilkan daftar antrean lagu lengkap dengan tombol halaman |
| | `/shuffle` | Mengacak urutan lagu di antrean |
| | `/loop [mode]` | Mengatur pengulangan: `off` (Mati), `track` (Lagu), atau `queue` (Antrean) |
| | `/remove [posisi]` | Menghapus satu lagu pada nomor urutan tertentu di antrean |
| | `/clear` | Mengosongkan seluruh daftar tunggu tanpa menghentikan lagu aktif |
| | `/move [dari] [ke]` | Memindahkan posisi urutan lagu di dalam antrean |
| | `/jump [posisi]` | Melompat langsung memutar lagu pada nomor urutan tertentu |
| | `/replay` | Mengulang lagu yang sedang diputar dari `00:00` |
| **Voice** | `/join` | Memanggil LaguKan masuk ke voice channel Anda |
| | `/disconnect` | Memutuskan koneksi suara & membersihkan sesi pemutar |
| | `/247 [status]` | Mengaktifkan/menonaktifkan mode siaga 24/7 di voice channel |
| | `/autoplay [status]` | Mengaktifkan/menonaktifkan pemutaran otomatis lagu terkait saat antrean habis |
| **Utility** | `/lyrics [judul]` | Menampilkan lirik lagu aktif atau berdasarkan pencarian judul |
| | `/filter [preset]` | Menerapkan filter audio (`bassboost`, `nightcore`, `vaporwave`, `8d`, `karaoke`, dll.) |
| | `/saveplaylist [nama] [publik]` | Menyimpan lagu aktif + antrean ke playlist SQLite |
| | `/loadplaylist [nama] [acak]` | Memuat & memutar playlist tersimpan dari database |
| | `/playlist [list/view/addtrack/removetrack/delete]` | Mengelola isi playlist tersimpan Anda |
| | `/dj [info/mode/role/channel/reset]` | Mengatur DJ Mode, Role DJ, & pembatasan Music Channel server |
| **Information** | `/help [perintah]` | Panduan interaktif seluruh perintah LaguKan |
| | `/ping` | Menampilkan latensi Discord Gateway, REST API, Lavalink, & SQLite |
| | `/botinfo` | Menampilkan identitas bot (`LaguKan`), developer (`666pallxXx`), & versi library |
| | `/serverinfo` | Menampilkan detail server Discord beserta konfigurasi musik aktif |
| | `/stats` | Menampilkan penggunaan RAM, CPU, uptime, & kesehatan node Lavalink |

---

## 🛠️ Persyaratan Sistem

1. **Perangkat Android dengan aplikasi Termux** *(unduh dari **F-Droid** atau GitHub resmi Termux — hindari versi lama di Play Store)*:
   - Minimal RAM kosong **512 MB** (jika menggunakan server Lavalink eksternal) atau **1.5 GB – 2 GB+** (jika menjalankan proses Java Lavalink sekaligus di ponsel yang sama).
2. **Node.js** versi `20.0.0` ke atas (disarankan `nodejs-lts` di Termux).
3. **Server Audio Lavalink v4**:
   - **Penting:** Lavalink adalah server pemroses audio berbasis **Java** yang berjalan **terpisah** dari proses Node.js bot.
   - Anda memiliki **2 pilihan** di Termux:
     - **Opsi A (Lokal di Termux):** Menginstal `openjdk-21` di Termux dan menjalankan `Lavalink.jar` pada jendela `tmux` kedua.
     - **Opsi B (Eksternal / Hemat RAM HP):** Menghubungkan bot ke server Lavalink v4 di VPS/PC lain melalui `.env`.

---

## 🤖 Cara Membuat Discord Application, Bot Token, Intents & Invite Link

1. Buka **[Discord Developer Portal](https://discord.com/developers/applications)** melalui browser, lalu login.
2. Tekan tombol **New Application**, beri nama **`LaguKan`**, lalu simpan.
3. Buka menu **General Information**:
   - Salin **Application ID** — nilai ini akan dimasukkan ke `DISCORD_CLIENT_ID` di file `.env`.
4. Buka menu **Bot** di panel kiri:
   - Tekan **Reset Token** / **View Token**, lalu salin token rahasia tersebut ke `DISCORD_TOKEN` pada file `.env`. *(Jangan pernah membagikan token ini ke siapa pun!)*
   - Matikan opsi *Require OAuth2 Code Grant* jika menyala.
   - **Pengaturan Gateway Intents:** LaguKan dirancang efisien menggunakan intent standar (`Guilds` dan `GuildVoiceStates`) yang sudah aktif secara otomatis tanpa wajib menyalakan Privileged Intents. Namun Anda boleh menyalakan *Server Members Intent* jika diinginkan.
5. Buka menu **OAuth2 -> URL Generator**:
   - Pada bagian **Scopes**, centang:
     - `bot`
     - `applications.commands` *(wajib agar Slash Command `/play` muncul!)*
   - Pada bagian **Bot Permissions** yang muncul di bawahnya, centang:
     - `View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Read Message History`
     - `Connect`
     - `Speak`
     - `Use Voice Activity`
   - Salin **Generated URL** di bagian paling bawah, buka di browser, lalu undang **LaguKan** ke server Discord Anda!

---

## 📱 Panduan Lengkap Instalasi & Menjalankan di Android Termux

Seluruh perintah di bawah ini dirancang **khusus untuk Android Termux** (tanpa Docker dan tanpa perintah khusus Ubuntu).

### 1. Update Paket & Instal Dependency Termux

Buka aplikasi **Termux**, lalu jalankan:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git openjdk-21 tmux curl nano
```

Verifikasi instalasi:

```bash
node -v
npm -v
java -version
```

*(Tips hemat daya Android: jalankan `termux-wake-lock` agar Android tidak menghentikan koneksi jaringan Termux saat layar ponsel mati).*

### 2. Clone Repository & Instal Dependency Project

```bash
git clone https://github.com/HOOOOOOQ/Lagukan-BOT.git
cd Lagukan-BOT
npm install
```

*(Atau cukup jalankan script otomatis: `bash scripts/termux-setup.sh`).*

### 3. Menyiapkan & Menjalankan Server Lavalink v4

Karena **Lavalink membutuhkan proses Java terpisah**, ikuti langkah berikut apabila Anda ingin menjalankan Lavalink langsung di dalam Termux:

```bash
mkdir -p ~/lavalink
cd ~/lavalink

# Unduh Lavalink v4 resmi terbaru dari GitHub Releases
curl -L -o Lavalink.jar https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar

# Salin contoh konfigurasi Lavalink dari folder LaguKan
cp ~/Lagukan-BOT/config/application.yml.example ~/lavalink/application.yml

# Edit password di dalam application.yml (ganti GANTI_DENGAN_PASSWORD_KUAT_ANDA)
nano ~/lavalink/application.yml
```

Jalankan Lavalink di latar belakang menggunakan **tmux** (dengan batas RAM ringan `-Xmx512M` agar ramah perangkat Android):

```bash
tmux new -s lavalink
cd ~/lavalink
java -Xmx512M -jar Lavalink.jar
```

Setelah muncul tulisan **`Lavalink is ready to accept connections`**, tekan kombinasi tombol **`Ctrl + B`** lalu lepas dan tekan **`D`** untuk keluar dari layar `tmux` tanpa mematikan Lavalink!

*(Catatan: Jika Anda menggunakan server Lavalink eksternal milik sendiri di luar Termux, lewati langkah 3 ini dan langsung masukkan host/port/password server tersebut ke file `.env`).*

### 4. Konfigurasi File `.env`

Kembali ke direktori project **LaguKan**:

```bash
cd ~/Lagukan-BOT
cp .env.example .env
nano .env
```

Isi bagian wajib berikut (pastikan `LAVALINK_PASSWORD` **sama persis** dengan `password` di `application.yml`):

```env
DISCORD_TOKEN=token_bot_discord_anda
DISCORD_CLIENT_ID=application_client_id_anda
DISCORD_GUILD_ID=

LAVALINK_NAME=LaguKan-Main
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=password_kuat_lavalink_anda
LAVALINK_SECURE=false
```

> **Opsional Spotify:** LaguKan sudah dapat membaca metadata lagu Spotify publik secara otomatis. Jika Anda ingin memproses Album atau Playlist Spotify berukuran besar dengan batas tinggi dan stabilitas maksimal, buat aplikasi gratis di [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) lalu isi `SPOTIFY_CLIENT_ID` dan `SPOTIFY_CLIENT_SECRET` di `.env`.

Simpan file di `nano` dengan menekan **`Ctrl + O` -> `Enter` -> `Ctrl + X`**.

### 5. Periksa Syntax & Daftarkan Slash Commands ke Discord

Sebelum menyalakan bot untuk pertama kali, periksa integritas kode dan daftarkan seluruh 33 Slash Command:

```bash
npm run check
npm run deploy
```

- Jika `DISCORD_GUILD_ID` diisi di `.env`, command akan muncul **instan (1 detik)** di server tersebut.
- Jika `DISCORD_GUILD_ID` dikosongkan, command didaftarkan secara **Global** ke semua server (sinkronisasi cache Discord global membutuhkan waktu sekitar 1–15 menit).

### 6. Menjalankan Bot LaguKan di Termux

Agar bot tetap menyala meskipun Anda menutup jendela Termux, aktifkan `wake-lock` dan jalankan di sesi `tmux` khusus:

```bash
termux-wake-lock
tmux new -s lagukan
cd ~/Lagukan-BOT
npm start
```

Tekan **`Ctrl + B`** lalu **`D`** untuk melepas tampilan `tmux` ke latar belakang.

### 7. Mengelola & Merestart Bot di Termux

- **Melihat log bot yang sedang berjalan:**
  ```bash
  tmux attach -t lagukan
  ```
- **Melihat log server Lavalink:**
  ```bash
  tmux attach -t lavalink
  ```
- **Merestart bot:**
  1. Masuk ke sesi bot: `tmux attach -t lagukan`
  2. Tekan **`Ctrl + C`** (LaguKan akan menutup sesi suara & menyimpan database SQLite dengan aman)
  3. Jalankan kembali: `npm start`
- **Mematikan seluruh sesi tmux:**
  ```bash
  tmux kill-session -t lagukan
  tmux kill-session -t lavalink
  ```

---

## 🔧 Panduan Troubleshooting (Mengatasi Masalah Umum)

### 1. Error: `Server audio Lavalink sedang offline (ECONNREFUSED)`
- **Penyebab:** Proses Java `Lavalink.jar` belum dinyalakan atau masih dalam proses booting (di Android biasanya butuh 10–25 detik hingga siap).
- **Solusi:** Cek `tmux attach -t lavalink`. Pastikan tertulis `Lavalink is ready to accept connections` dan port `2333` sama dengan `LAVALINK_PORT` di `.env`. Node Health Monitor pada LaguKan akan otomatis menyambung kembali dalam maksimal 30 detik tanpa perlu merestart bot.

### 2. Error: `Autentikasi Lavalink GAGAL (401 Unauthorized)`
- **Penyebab:** Nilai `LAVALINK_PASSWORD` di file `.env` berbeda dengan nilai `lavalink.server.password` pada `application.yml`.
- **Solusi:** Samakan kedua password tersebut persis (perhatikan huruf besar/kecil dan spasi), lalu restart Lavalink dan bot.

### 3. Slash Command (`/play`, `/help`, dll.) Tidak Muncul di Discord
- **Penyebab:** Saat mengundang bot, scope `applications.commands` belum dicentang, atau `npm run deploy` belum dijalankan.
- **Solusi:**
  1. Jalankan `npm run deploy` di Termux dan pastikan muncul pesan `Sinkronisasi Slash Command berhasil`.
  2. Untuk pengujian instan, isi `DISCORD_GUILD_ID` dengan ID server Discord Anda lalu jalankan `npm run deploy` lagi.
  3. Undang ulang bot menggunakan URL OAuth2 yang menyertakan `bot` + `applications.commands`.

### 4. Termux Tiba-tiba Mati Sendiri Saat Layar HP Terkunci (`Signal 9` / Killed)
- **Penyebab:** Penghemat baterai Android atau *Android 12+ Phantom Process Killer*.
- **Solusi:**
  1. Jalankan perintah `termux-wake-lock` di Termux.
  2. Buka **Pengaturan HP -> Aplikasi -> Termux -> Baterai**, lalu pilih **Tidak Dibatasi (Unrestricted)**.
  3. Pada Android 12+, matikan pembatas proses latar belakang melalui *Wireless Debugging* (`Disable child process restrictions` di Developer Options Android 14+, atau perintah ADB standar Android).

### 5. Bot Masuk ke Voice Channel Tetapi Tidak Ada Suara / Gagal Memutar YouTube
- **Penyebab:** Plugin `youtube-plugin` pada Lavalink perlu diperbarui ke rilis terbaru, atau bot terkena *Server Mute* di Discord.
- **Solusi:**
  1. Periksa versi terbaru `dev.lavalink.youtube:youtube-plugin` di [GitHub Lavalink YouTube Plugin](https://github.com/lavalink-devs/youtube-source/releases), perbarui nomor versinya di `application.yml`, lalu restart Lavalink.
  2. Pastikan bot memiliki izin `Connect` dan `Speak` (dan menjadi *Speaker* jika berada di Stage Channel).

### 6. Error Token Discord Tidak Valid (`TokenInvalid`)
- **Penyebab:** Terdapat spasi berlebih atau tanda kutip yang salah saat menyalin `DISCORD_TOKEN` ke `.env`.
- **Solusi:** Buka `nano .env`, pastikan formatnya `DISCORD_TOKEN=MTIz...` tanpa spasi dan tanpa tanda kutip, atau lakukan *Reset Token* di Discord Developer Portal.

---

## 🔒 Standar Keamanan Project

- Seluruh kredensial rahasia (`DISCORD_TOKEN`, `LAVALINK_PASSWORD`, `SPOTIFY_CLIENT_SECRET`) hanya dibaca dari `.env` yang dikecualikan di `.gitignore`.
- Sistem logger (`src/utils/logger.js`) dilengkapi **redaksi otomatis** sehingga token tidak pernah bocor ke layar terminal maupun file `./logs/lagukan.log`.
- Pemblokiran otomatis alamat jaringan lokal/privat (proteksi SSRF) pada input URL pengguna.
- Tidak menggunakan `eval()`, backdoor, ataupun telemetri pihak ketiga.

---

**Dikembangkan dengan penuh dedikasi oleh `666pallxXx` — Project `LaguKan`.**
