'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { Collection, PermissionFlagsBits, ChannelType } = require('discord.js');
const { LoadType, Constants } = require('shoukaku');
const OpusScript = require('opusscript');
const davey = require('@snazzah/davey');
const { xchacha20poly1305 } = require('@noble/ciphers/chacha.js');

const { config } = require('../config/config');
const { LaguKanClient } = require('../src/client');
const {
  classifyTrackFailure,
  inspectDaveSupport
} = require('../src/music/audioDiagnostics');
const { classifyInput } = require('../src/music/sourceResolver');

/**
 * Menghasilkan file WAV PCM 48kHz 16-bit Stereo berisi gelombang musik 440 Hz (nada A4 jernih & terdengar).
 */
function generateAudible440HzWavBuffer(durationMs = 800) {
  const sampleRate = 48000;
  const channels = 2;
  const bitsPerSample = 16;
  const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = totalSamples * channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  const amplitude = 16000; // ~ -6 dBFS (sangat jelas terdengar, bukan silence!)
  for (let i = 0; i < totalSamples; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude);
    const offset = 44 + i * 4;
    buf.writeInt16LE(sample, offset);
    buf.writeInt16LE(sample, offset + 2);
  }

  return buf;
}

/**
 * Menghasilkan sertifikat TLS self-signed sementara untuk pengujian lokal Discord Voice Gateway v8 (wss://).
 */
function createEphemeralTlsCert(tmpDir) {
  const keyPath = path.join(tmpDir, 'voice-test-key.pem');
  const certPath = path.join(tmpDir, 'voice-test-cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1'
    ],
    { stdio: 'ignore' }
  );
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
}

class MockShoukakuPlayer extends EventEmitter {
  constructor(node, onPlay) {
    super();
    this.node = node;
    this._asyncLifecycle = true;
    this.track = null;
    this.volume = 100;
    this.paused = false;
    this.playCalls = [];
    this.onPlay = onPlay;
  }

  async playTrack(payload) {
    this.track = payload.track.encoded;
    if (typeof payload.volume === 'number') this.volume = payload.volume;
    this.playCalls.push(payload);
    if (this.onPlay) {
      queueMicrotask(() => this.onPlay(this, payload));
    }
  }

  async stopTrack() {
    this.track = null;
  }

  async setPaused(p) {
    this.paused = p;
  }

  async setGlobalVolume(v) {
    this.volume = v;
  }

  async clearFilters() {}
}

test('Audit Dependency ARM64 & Kompatibilitas Native DAVE (@snazzah/davey + @noble/ciphers + opusscript)', () => {
  const daveInfo = inspectDaveSupport();
  assert.equal(daveInfo.voiceVersion, '0.19.2');
  assert.equal(daveInfo.daveyLoaded, true, '@snazzah/davey harus aktif');
  assert.equal(daveInfo.daveProtocolVersion, 1, 'DAVE Protocol v1 wajib didukung');
  assert.equal(daveInfo.hasAes256Gcm, true);
  assert.equal(daveInfo.hasXChaCha20Poly1305, true, '@noble/ciphers xchacha20poly1305 wajib aktif');
  assert.match(String(daveInfo.opusLibrary), /^opusscript@/);

  // Pastikan package-lock.json mendukung Android ARM64 & WASM dan bebas dari build script C++ desktop-only
  const lock = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package-lock.json'), 'utf8')
  );
  assert.ok(
    lock.packages['node_modules/@snazzah/davey-android-arm64'],
    'Paket prebuilt native @snazzah/davey-android-arm64 wajib terdaftar di package-lock.json'
  );
  assert.ok(
    lock.packages['node_modules/@snazzah/davey-wasm32-wasi'],
    'Paket fallback universal @snazzah/davey-wasm32-wasi wajib terdaftar di package-lock.json'
  );

  for (const [pkgKey, meta] of Object.entries(lock.packages)) {
    if (!pkgKey) continue;
    assert.notEqual(
      meta.hasInstallScript,
      true,
      `Paket ${pkgKey} tidak boleh bergantung pada kompilasi native node-gyp yang rawan gagal di Termux`
    );
    if (!meta.optional && Array.isArray(meta.cpu)) {
      assert.ok(
        meta.cpu.includes('arm64'),
        `Paket wajib ${pkgKey} harus mendukung arsitektur ARM64`
      );
    }
  }

  // Uji kriptografi MLS DAVE nyata menggunakan @snazzah/davey
  const session = new davey.DAVESession(1, '123456789012345678', '987654321098765432');
  const keyPkg = session.getSerializedKeyPackage();
  assert.ok(Buffer.isBuffer(keyPkg) && keyPkg.length > 32, 'MLS KeyPackage DAVE v1 harus valid');
});

test('Klasifikasi 5 Root Cause YouTube & DAVE + Circuit-Breaker Otomatis ke SoundCloud & Bandcamp', async () => {
  // 1. YouTube meminta login / deteksi bot
  const loginBot = classifyTrackFailure({
    message: "Sign in to confirm you're not a bot"
  });
  assert.equal(loginBot.code, 'YOUTUBE_LOGIN_BOT_DETECTION');
  assert.equal(loginBot.isYoutubeFailure, true);

  // 2. YouTube HTTP 403 Forbidden (TIDAK boleh salah diklasifikasikan sebagai LAVALINK_WS_AUTH_FAILED!)
  const http403 = classifyTrackFailure({
    message: 'Not success status code: 403'
  });
  assert.equal(http403.code, 'YOUTUBE_HTTP_403_FORBIDDEN');
  assert.equal(http403.isYoutubeFailure, true);

  // 3. Semua client YouTube gagal (AllClientsFailedException) beserta ringkasan per-client
  const allFailed = classifyTrackFailure({
    message:
      "(yts.version: 1.18.2) All clients failed to load the item.\n\nClient [ANDROID_VR]: Sign in to confirm you're not a bot\n\nClient [TVHTML5_SIMPLY]: Not success status code: 403"
  });
  assert.equal(allFailed.code, 'YOUTUBE_ALL_CLIENTS_FAILED');
  assert.equal(allFailed.isYoutubeFailure, true);
  assert.match(allFailed.shortReason, /ANDROID_VR:\s*login\/bot-check/);
  assert.match(allFailed.shortReason, /TVHTML5_SIMPLY:\s*HTTP 403/);

  // 4. DAVE_E2EE_NATIVE_MISSING terpisah dari YouTube error
  const daveMissing = classifyTrackFailure({
    message: 'Discord Voice Close 4017 (DAVE E2EE libdave-jvm): DAVE protocol required'
  });
  assert.equal(daveMissing.code, 'DAVE_E2EE_NATIVE_MISSING');
  assert.equal(daveMissing.isDaveVoiceFailure, true);
  assert.equal(daveMissing.isYoutubeFailure, false);

  // 5. Validasi sumber alternatif baru pada classifyInput (Bandcamp, Vimeo, Twitch, Explicit Search)
  assert.equal(classifyInput('https://artist.bandcamp.com/track/senja').type, 'bandcamp');
  assert.equal(classifyInput('https://vimeo.com/12345678').type, 'vimeo');
  assert.equal(classifyInput('https://www.twitch.tv/monstercat').type, 'twitch');
  const explicitBc = classifyInput('bcsearch:ambient piano');
  assert.equal(explicitBc.type, 'search');
  assert.equal(explicitBc.explicitPrefix, 'bcsearch');

  // 6. Uji integrasi penuh: YouTube AllClientsFailedException -> SoundCloud kosong -> Bandcamp (bcsearch) SUKSES!
  //    Dan pastikan permintaan /play berikutnya langsung memprioritaskan scsearch/bcsearch berkat Circuit-Breaker!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-yt-cb-'));
  config.database.path = path.join(tmpDir, 'cb.sqlite');
  const client = new LaguKanClient();
  const sentMessages = [];

  try {
    await client.init();
    const resolveLog = [];

    const fakeNode = {
      name: 'LaguKan-Main',
      state: Constants.State.CONNECTED,
      sessionId: 'sess-cb-1',
      rest: {
        resolve: async (identifier) => {
          resolveLog.push(identifier);
          if (identifier.startsWith('ytmsearch:')) {
            return {
              loadType: LoadType.SEARCH,
              data: [
                {
                  encoded: 'enc-yt-blocked-403',
                  info: {
                    identifier: 'yt-id-403',
                    isSeekable: true,
                    author: 'Pamungkas',
                    length: 240000,
                    isStream: false,
                    position: 0,
                    title: 'To The Bone',
                    uri: 'https://www.youtube.com/watch?v=yt-id-403',
                    sourceName: 'youtube'
                  }
                }
              ]
            };
          }
          if (identifier.startsWith('scsearch:')) {
            // Simulasikan SoundCloud tidak menemukan lagu pertama agar menguji fallback ke-2 (Bandcamp bcsearch)
            if (identifier.includes('To The Bone')) {
              return { loadType: LoadType.EMPTY, data: [] };
            }
            return {
              loadType: LoadType.SEARCH,
              data: [
                {
                  encoded: 'enc-sc-direct-2',
                  info: {
                    identifier: 'sc-id-2',
                    isSeekable: true,
                    author: 'Tulus',
                    length: 210000,
                    isStream: false,
                    position: 0,
                    title: 'Hati-Hati di Jalan',
                    uri: 'https://soundcloud.com/tulus/hati-hati-di-jalan',
                    sourceName: 'soundcloud'
                  }
                }
              ]
            };
          }
          if (identifier.startsWith('bcsearch:')) {
            return {
              loadType: LoadType.SEARCH,
              data: [
                {
                  encoded: 'enc-bc-playable-1',
                  info: {
                    identifier: 'bc-id-1',
                    isSeekable: true,
                    author: 'Pamungkas',
                    length: 239000,
                    isStream: false,
                    position: 0,
                    title: 'To The Bone (Bandcamp Audio)',
                    uri: 'https://pamungkas.bandcamp.com/track/to-the-bone',
                    sourceName: 'bandcamp'
                  }
                }
              ]
            };
          }
          return { loadType: LoadType.EMPTY, data: [] };
        }
      }
    };

    const player = new MockShoukakuPlayer(fakeNode, (p, payload) => {
      if (payload.track.encoded === 'enc-yt-blocked-403') {
        p.emit('exception', {
          exception: {
            message:
              "(yts.version: 1.18.2) All clients failed to load the item.\n\nClient [ANDROID_VR]: Sign in to confirm you're not a bot\n\nClient [TVHTML5_SIMPLY]: Not success status code: 403"
          }
        });
        p.emit('end', { reason: 'loadFailed' });
        return;
      }
      if (payload.track.encoded === 'enc-bc-playable-1' || payload.track.encoded === 'enc-sc-direct-2') {
        p.emit('start', { track: { encoded: payload.track.encoded } });
      }
    });

    const voiceChannel = {
      id: 'vc-cb-1',
      name: 'Musik Utama',
      type: ChannelType.GuildVoice,
      full: false,
      isVoiceBased: () => true,
      members: { filter: () => ({ size: 1 }) },
      permissionsFor: () => ({ has: () => true })
    };
    const textChannel = {
      id: 'tc-cb-1',
      type: ChannelType.GuildText,
      isVoiceBased: () => false,
      send: async (payload) => {
        const m = { id: `m-${sentMessages.length}`, payload, edit: async (u) => ((m.payload = u), m) };
        sentMessages.push(m);
        return m;
      }
    };
    const guild = {
      id: 'guild-cb-1',
      name: 'Server Uji YouTube Fallback',
      shardId: 0,
      channels: {
        cache: new Collection([
          ['vc-cb-1', voiceChannel],
          ['tc-cb-1', textChannel]
        ]),
        fetch: async (id) => (id === 'tc-cb-1' ? textChannel : voiceChannel)
      },
      members: { me: { voice: { channelId: 'vc-cb-1', suppress: false } } }
    };

    client.guilds.cache.set(guild.id, guild);
    client.channels.cache.set('tc-cb-1', textChannel);
    client.shoukaku.nodes.clear();
    client.shoukaku.nodes.set('LaguKan-Main', fakeNode);
    client.shoukaku.getIdealNode = () => fakeNode;
    client.shoukaku.joinVoiceChannel = async ({ guildId }) => {
      client.shoukaku.players.set(guildId, player);
      return player;
    };
    client.shoukaku.leaveVoiceChannel = async (guildId) => {
      client.shoukaku.players.delete(guildId);
    };

    const makeInteraction = (songQuery) => {
      const st = { deferred: false, replied: false, lastPayload: null };
      return {
        id: `int-${Math.random()}`,
        guildId: guild.id,
        channelId: textChannel.id,
        guild,
        inGuild: () => true,
        user: { id: 'u-1', tag: '666pallxXx' },
        member: {
          voice: { channel: voiceChannel },
          permissions: { has: (f) => f === PermissionFlagsBits.Administrator },
          roles: { cache: new Map() }
        },
        options: { getString: () => songQuery },
        get deferred() { return st.deferred; },
        get replied() { return st.replied; },
        deferReply: async () => { st.deferred = true; },
        reply: async (p) => ((st.replied = true), (st.lastPayload = p)),
        editReply: async (p) => ((st.replied = true), (st.lastPayload = p)),
        _state: st
      };
    };

    await client.commands.get('play').execute(makeInteraction('Pamungkas To The Bone'), client);

    const mp = client.playerManager.get(guild.id);
    assert.equal(mp.state, 'PLAYING');
    assert.equal(mp.currentTrack.info.sourceName, 'bandcamp', 'Harus otomatis fallback ke Bandcamp ketika YouTube & SoundCloud gagal');
    assert.equal(
      client.audioDiagnostics.isYoutubeDegraded('LaguKan-Main'),
      true,
      'Circuit-breaker YouTube wajib aktif setelah AllClientsFailedException'
    );

    // Permintaan /play ke-2 wajib langsung memanggil scsearch: terlebih dahulu (tanpa menyentuh ytmsearch yang sedang diblokir!)
    resolveLog.length = 0;
    await client.commands.get('play').execute(makeInteraction('Tulus Hati Hati di Jalan'), client);
    assert.ok(
      resolveLog[0].startsWith('scsearch:'),
      `Saat YouTube terdegradasi, pencarian harus langsung dimulai dari scsearch:, tetapi mendapat: ${resolveLog[0]}`
    );
  } finally {
    await client.shutdown('CB_TEST_DONE');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Migrasi Otomatis application.yml Lama & Profil glibc/bionic pada start-lavalink-termux.sh', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-yml-mig-'));
  const lavalinkDir = path.join(tmpDir, 'lavalink');
  fs.mkdirSync(lavalinkDir, { recursive: true });

  const oldYmlPath = path.join(lavalinkDir, 'application.yml');
  const fakeJarPath = path.join(lavalinkDir, 'Lavalink.jar');
  fs.writeFileSync(fakeJarPath, 'stub-jar', 'utf8');
  fs.writeFileSync(
    oldYmlPath,
    [
      'server:',
      '  port: 2333',
      'lavalink:',
      '  plugins:',
      '    - dependency: "dev.lavalink.youtube:youtube-plugin:1.18.2"',
      '  server:',
      '    password: "PasswordLamaPengguna_TetapAman!"'
    ].join('\n'),
    'utf8'
  );

  try {
    // Jalankan --setup-glibc pada non-Termux (keluar rapi kode 0 setelah menjalankan blok migrasi di bagian atas script!)
    const out = execFileSync(
      'bash',
      [path.resolve(__dirname, '../scripts/start-lavalink-termux.sh'), '--setup-glibc'],
      {
        env: {
          ...process.env,
          LAVALINK_DIR: lavalinkDir,
          TERMUX_VERSION: ''
        },
        encoding: 'utf8'
      }
    );

    assert.ok(!out.includes('PasswordLamaPengguna_TetapAman!'), 'Password tidak boleh bocor ke log');
    const migratedYml = fs.readFileSync(oldYmlPath, 'utf8');
    assert.match(migratedYml, /2be8e542d3f6f178e048dca565892684c2e40177/);
    assert.match(migratedYml, /clientOptions:/);
    // Pastikan backup dibuat
    const backups = fs.readdirSync(lavalinkDir).filter((f) => f.startsWith('application.yml.bak.'));
    assert.equal(backups.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('REAL END-TO-END VOICE & AUDIO TEST: Lavalink Close 4017 (DAVE_E2EE_NATIVE_MISSING) -> Auto-Recovery Direct DAVE v1 -> Real WSS + UDP AEAD + Decoded 440Hz Audible PCM Verification', async () => {
  const prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-e2e-dave-'));
  config.database.path = path.join(tmpDir, 'e2e-dave.sqlite');

  // 1. Server HTTP Audio Sah yang menyajikan gelombang musik 440 Hz nyata (WAV 48kHz Stereo 16-bit)
  const wavBuffer = generateAudible440HzWavBuffer(900);
  const audioHttpServer = http.createServer((req, res) => {
    if (req.url === '/audible-440hz.wav') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wavBuffer.length
      });
      res.end(wavBuffer);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => audioHttpServer.listen(0, '127.0.0.1', resolve));
  const audioPort = audioHttpServer.address().port;
  const legitimateStreamUrl = `http://127.0.0.1:${audioPort}/audible-440hz.wav`;

  // 2. Server UDP Media Discord nyata + Dekripsi AEAD XChaCha20-Poly1305 + Dekoder Opus
  const secretKey = crypto.randomBytes(32);
  const ssrc = 778899;
  const receivedEncryptedPackets = [];
  const decodedOpusPayloads = [];
  const speakingEvents = [];
  const identifyPayloads = [];
  const receivedMlsKeyPackages = [];

  const voiceUdpServer = dgram.createSocket('udp4');
  await new Promise((resolve) => voiceUdpServer.bind(0, '127.0.0.1', resolve));
  const voiceUdpPort = voiceUdpServer.address().port;

  voiceUdpServer.on('message', (msg, rinfo) => {
    // Paket IP Discovery Discord (74 byte, diawali 0x0001)
    if (msg.length === 74 && msg.readUInt16BE(0) === 0x0001) {
      const reply = Buffer.alloc(74);
      reply.writeUInt16BE(0x0002, 0);
      reply.writeUInt16BE(70, 2);
      reply.writeUInt32BE(msg.readUInt32BE(4), 4);
      reply.write('127.0.0.1', 8, 'ascii');
      reply.writeUInt16BE(rinfo.port, 72);
      voiceUdpServer.send(reply, rinfo.port, rinfo.address);
      return;
    }

    // Paket Audio RTP Terenkripsi (header 12 byte: 0x80 0x78)
    if (msg.length > 20 && msg[0] === 0x80 && msg[1] === 0x78) {
      receivedEncryptedPackets.push(Buffer.from(msg));
      try {
        const rtpHeader = msg.subarray(0, 12);
        const noncePadding = msg.subarray(msg.length - 4);
        const ciphertext = msg.subarray(12, msg.length - 4);
        const nonce24 = Buffer.alloc(24);
        noncePadding.copy(nonce24, 0);

        const decrypted = Buffer.from(
          xchacha20poly1305(secretKey, nonce24, rtpHeader).decrypt(ciphertext)
        );
        decodedOpusPayloads.push(decrypted);
      } catch {
        // Abaikan jika transisi kunci
      }
    }
  });

  // 3. Server Discord Voice Gateway v8 nyata berbasis HTTPS/WSS (memverifikasi DAVE Protocol v1)
  const tlsCreds = createEphemeralTlsCert(tmpDir);
  const httpsVoiceServer = https.createServer(tlsCreds);
  const wssVoice = new WebSocketServer({ server: httpsVoiceServer });

  wssVoice.on('connection', (ws) => {
    // Kirim Op 8 (Hello)
    ws.send(JSON.stringify({ op: 8, d: { heartbeat_interval: 15000 } }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data);
        // Binary Op 26 = DaveMlsKeyPackage dari @snazzah/davey
        const op = buf[0];
        if (op === 26) {
          receivedMlsKeyPackages.push(buf.subarray(1));
        }
        return;
      }

      const packet = JSON.parse(data.toString());
      if (packet.op === 0) {
        // Op 0 = Identify — pastikan max_dave_protocol_version >= 1 (enkripsi DAVE TIDAK dinonaktifkan!)
        identifyPayloads.push(packet.d);
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              ssrc,
              ip: '127.0.0.1',
              port: voiceUdpPort,
              modes: ['aead_xchacha20_poly1305_rtpsize', 'aead_aes256_gcm_rtpsize']
            }
          })
        );
      } else if (packet.op === 1) {
        // Op 1 = SelectProtocol -> balas Op 4 SessionDescription dengan dave_protocol_version: 1
        ws.send(
          JSON.stringify({
            op: 4,
            d: {
              mode: 'aead_xchacha20_poly1305_rtpsize',
              secret_key: [...secretKey],
              dave_protocol_version: 1
            }
          })
        );
      } else if (packet.op === 3) {
        // Op 3 = Heartbeat -> Op 6 HeartbeatAck
        ws.send(JSON.stringify({ op: 6, d: packet.d }));
      } else if (packet.op === 5) {
        // Op 5 = Speaking
        speakingEvents.push(packet.d);
      }
    });
  });

  await new Promise((resolve) => httpsVoiceServer.listen(0, '127.0.0.1', resolve));
  const wssVoicePort = httpsVoiceServer.address().port;

  // 4. Jalankan LaguKanClient & simulasikan Lavalink gagal dengan Close 4017 (DAVE_E2EE_NATIVE_MISSING)
  const client = new LaguKanClient();
  const sentChannelMessages = [];

  try {
    await client.init();
    client.user = { id: '111222333444555666', tag: 'LaguKan#0001' };

    const fakeNode = {
      name: 'LaguKan-Bionic-Node',
      state: Constants.State.CONNECTED,
      ws: {}, // Menandakan sesi Lavalink asinkron dengan pemeriksaan voice transport aktif
      sessionId: 'sess-bionic-4017',
      rest: {
        getPlayer: async () => ({ state: { connected: false, ping: -1, position: 0 } }),
        resolve: async () => ({
          loadType: LoadType.TRACK,
          data: {
            encoded: 'enc-http-wav-440hz',
            info: {
              identifier: legitimateStreamUrl,
              isSeekable: false,
              author: 'LaguKan Synth Lab',
              length: 900,
              isStream: false,
              position: 0,
              title: 'Nada Uji 440Hz A4 Jernih',
              uri: legitimateStreamUrl,
              sourceName: 'http'
            }
          }
        })
      }
    };

    const brokenBionicShoukakuPlayer = new MockShoukakuPlayer(fakeNode, (p, payload) => {
      // Simulasikan persis log error live pengguna: Lavalink Koe di Bionic terkena Close 4017 (DAVE_E2EE_NATIVE_MISSING)
      p.emit('closed', { code: 4017, reason: 'DAVE protocol is required for this channel' });
      p.emit('start', { track: { encoded: payload.track.encoded } });
    });

    const voiceChannel = {
      id: '999888777666555444',
      name: 'Studio Uji Suara Nyata',
      type: ChannelType.GuildVoice,
      full: false,
      isVoiceBased: () => true,
      members: { filter: () => ({ size: 1 }) },
      permissionsFor: () => ({ has: () => true })
    };

    const textChannel = {
      id: '888777666555444333',
      type: ChannelType.GuildText,
      isVoiceBased: () => false,
      send: async (payload) => {
        const m = {
          id: `np-${sentChannelMessages.length + 1}`,
          payload,
          edit: async (u) => ((m.payload = u), m)
        };
        sentChannelMessages.push(m);
        return m;
      }
    };

    // Adapter voice Discord nyata yang menghubungkan @discordjs/voice ke server WSS + UDP lokal kita
    const guild = {
      id: '777666555444333222',
      name: 'Server Verifikasi Audio Terdengar',
      shardId: 0,
      voiceAdapterCreator: (methods) => ({
        sendPayload: (payload) => {
          if (payload.op === 4) {
            queueMicrotask(() => {
              methods.onVoiceStateUpdate({
                guild_id: '777666555444333222',
                channel_id: payload.d.channel_id,
                user_id: '111222333444555666',
                session_id: 'real-dave-voice-session-01',
                self_deaf: true,
                self_mute: false
              });
              if (payload.d.channel_id) {
                methods.onVoiceServerUpdate({
                  guild_id: '777666555444333222',
                  token: 'real-voice-token-xyz',
                  endpoint: `127.0.0.1:${wssVoicePort}`
                });
              }
            });
          }
          return true;
        },
        destroy: () => {}
      }),
      channels: {
        cache: new Collection([
          [voiceChannel.id, voiceChannel],
          [textChannel.id, textChannel]
        ]),
        fetch: async (id) => (id === textChannel.id ? textChannel : voiceChannel)
      },
      members: {
        me: { voice: { channelId: voiceChannel.id, suppress: false } }
      }
    };

    client.guilds.cache.set(guild.id, guild);
    client.channels.cache.set(textChannel.id, textChannel);
    client.shoukaku.nodes.clear();
    client.shoukaku.nodes.set(fakeNode.name, fakeNode);
    client.shoukaku.getIdealNode = () => fakeNode;
    client.shoukaku.joinVoiceChannel = async ({ guildId }) => {
      client.shoukaku.players.set(guildId, brokenBionicShoukakuPlayer);
      return brokenBionicShoukakuPlayer;
    };
    client.shoukaku.leaveVoiceChannel = async (guildId) => {
      client.shoukaku.players.delete(guildId);
    };

    // Siapkan sesi MusicPlayer dan izinkan loopback hanya untuk server HTTP audio pengujian ini
    const mp = await client.playerManager.getOrCreate({
      guild,
      voiceChannel,
      textChannelId: textChannel.id
    });
    mp._allowLoopbackDirectVoice = true;

    const trackObj = {
      encoded: 'enc-http-wav-440hz',
      directStreamUrl: legitimateStreamUrl,
      info: {
        identifier: legitimateStreamUrl,
        isSeekable: false,
        author: 'LaguKan Synth Lab',
        length: 900,
        isStream: false,
        position: 0,
        title: 'Nada Uji 440Hz A4 Jernih',
        uri: legitimateStreamUrl,
        sourceName: 'http'
      },
      requester: { id: 'u-dev', tag: '666pallxXx' }
    };

    mp.queue.enqueue(trackObj);
    const startRes = await mp.playIfIdle({ waitForStart: true });

    // Biarkan stream mengalir ~300ms agar puluhan frame Opus terenkripsi terkirim ke server UDP
    await new Promise((r) => setTimeout(r, 320));

    // VERIFIKASI 1: Pemutaran berstatus PLAYING melalui Direct DAVE v1 setelah Lavalink terkena Close 4017!
    assert.equal(startRes.started, true);
    assert.equal(startRes.usedDirectDave, true);
    assert.equal(mp.usingDirectDaveVoice, true);
    assert.equal(mp.state, 'PLAYING');
    assert.equal(sentChannelMessages.length, 1, 'Panel Now Playing harus tampil setelah paket audio terverifikasi');

    // VERIFIKASI 2: Handshake keamanan DAVE Protocol v1 & Speaking TIDAK dinonaktifkan!
    assert.ok(identifyPayloads.length >= 1, 'Voice Gateway wajib menerima paket Identify');
    assert.equal(
      identifyPayloads[0].max_dave_protocol_version,
      1,
      'Bot WAJIB mengiklankan max_dave_protocol_version = 1 (tidak boleh 0 / bypass!)'
    );
    assert.ok(
      receivedMlsKeyPackages.length >= 1,
      'Bot WAJIB mengirimkan paket biner MLS KeyPackage (Op 26) dari @snazzah/davey'
    );
    assert.ok(
      speakingEvents.some((s) => s.speaking === 1),
      'Bot WAJIB mengirimkan status Speaking=1 sebelum mengirim frame Opus'
    );

    // VERIFIKASI 3: Paket RTP terenkripsi benar-benar diterima oleh socket UDP Discord!
    assert.ok(
      receivedEncryptedPackets.length >= 10,
      `Minimal 10 paket RTP Opus terenkripsi harus tiba di UDP server, diterima: ${receivedEncryptedPackets.length}`
    );
    assert.ok(
      decodedOpusPayloads.length >= 10,
      `Minimal 10 frame harus berhasil didekripsi AEAD XChaCha20-Poly1305, didekripsi: ${decodedOpusPayloads.length}`
    );

    // VERIFIKASI 4: Dekode frame Opus kembali ke PCM 48kHz menggunakan opusscript & buktikan BUKAN SILENCE!
    const opusDecoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
    let nonSilentFrames = 0;
    let peakSample = 0;
    let sumSquares = 0;
    let totalSamplesCounted = 0;

    try {
      for (const payload of decodedOpusPayloads) {
        if (payload.equals(SILENCE_FRAME)) continue;
        // Pada mode passthrough awal sebelum MLS epoch grup penuh terbentuk, payload adalah frame Opus murni
        const pcmBuf = opusDecoder.decode(payload);
        if (pcmBuf && pcmBuf.length >= 3840) {
          nonSilentFrames += 1;
          for (let offset = 0; offset < pcmBuf.length; offset += 2) {
            const val = pcmBuf.readInt16LE(offset);
            const absVal = Math.abs(val);
            if (absVal > peakSample) peakSample = absVal;
            sumSquares += val * val;
            totalSamplesCounted += 1;
          }
        }
      }
    } finally {
      opusDecoder.delete();
    }

    const rms = totalSamplesCounted > 0 ? Math.sqrt(sumSquares / totalSamplesCounted) : 0;
    assert.ok(
      nonSilentFrames >= 8,
      `Harus terdapat minimal 8 frame Opus berisi gelombang suara nyata (bukan silence), ditemukan: ${nonSilentFrames}`
    );
    assert.ok(
      rms > 4000 && peakSample > 8000,
      `Gelombang suara hasil dekode harus terdengar jelas (RMS > 4000, Peak > 8000), aktual: RMS=${Math.round(
        rms
      )}, Peak=${peakSample}`
    );

    // Uji kontrol Pause, Resume, dan Volume pada mode Direct DAVE Voice
    await mp.setVolume(75);
    assert.equal(mp.volume, 75);
    await mp.pause();
    assert.equal(mp.state, 'PAUSED');
    await mp.resume();
    assert.equal(mp.state, 'PLAYING');
    await mp.stop({ keepConnectionIf247: false });
  } finally {
    if (prevTlsReject === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsReject;
    }
    await client.shutdown('E2E_DAVE_TEST_DONE');
    wssVoice.close();
    await new Promise((r) => httpsVoiceServer.close(r));
    await new Promise((r) => voiceUdpServer.close(r));
    await new Promise((r) => audioHttpServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
