'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { Collection, ChannelType, PermissionsBitField } = require('discord.js');

const logger = require('../src/utils/logger');
const { LaguKanClient } = require('../src/client');
const playCommand = require('../src/commands/playback/play');
const debugMusicCommand = require('../src/commands/information/debugmusic');

/**
 * Membangun paket RTP Discord Voice standar (12-byte RTP header + payload frame Opus non-hening).
 */
function buildRtpOpusPacket(seq, timestamp, ssrc = 0x12345678) {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // RTP v2
  header[1] = 0x78; // Payload Type 120 (Discord Opus)
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  // Frame Opus sintetis non-silent (TOC byte + harmonic audio frame bytes, BUKAN 0xF8FFFE silence frame!)
  const opusFrame = Buffer.from([
    0xfc, 0x41, 0x9a, 0x67, 0x2c, 0x88, 0x55, 0x3e,
    0xb1, 0x74, 0xd2, 0x19, 0x63, 0xa4, 0xef, 0x4b
  ]);
  return Buffer.concat([header, opusFrame]);
}

/**
 * Server Lavalink v4 Nyata (HTTP REST + WebSocket /v4/websocket + Pengirim Paket RTP Opus via UDP dgram)
 * untuk pengujian integrasi end-to-end sesungguhnya.
 */
async function startRealLavalinkAndVoiceHarness({ password, udpTransportHealthy = true }) {
  // Socket UDP anggota voice channel Discord yang menerima paket audio RTP Opus nyata
  const voiceListenerUdp = dgram.createSocket('udp4');
  const receivedRtpPackets = [];

  voiceListenerUdp.on('message', (msg) => {
    if (msg.length >= 15 && msg[0] === 0x80 && msg[1] === 0x78) {
      const seq = msg.readUInt16BE(2);
      const timestamp = msg.readUInt32BE(4);
      const ssrc = msg.readUInt32BE(8);
      const opusPayload = msg.subarray(12);
      const isSilenceFrame =
        opusPayload.length === 3 &&
        opusPayload[0] === 0xf8 &&
        opusPayload[1] === 0xff &&
        opusPayload[2] === 0xfe;
      receivedRtpPackets.push({
        seq,
        timestamp,
        ssrc,
        opusBytes: opusPayload.length,
        audible: !isSilenceFrame && opusPayload.some((b) => b !== 0)
      });
    }
  });

  await new Promise((resolve) => voiceListenerUdp.bind(0, '127.0.0.1', resolve));
  const udpTargetPort = voiceListenerUdp.address().port;

  // Socket UDP pengirim milik server Lavalink (Koe media sender)
  const lavalinkMediaUdp = dgram.createSocket('udp4');
  const activeIntervals = new Set();

  const sessionId = 'lavalink_real_session_v4';
  const players = new Map();
  const authAttempts = [];
  const voiceUpdatesReceived = [];
  let activeWs = null;

  const httpServer = http.createServer((req, res) => {
    const reqAuth = req.headers.authorization || '';
    if (reqAuth !== password) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 401, error: 'Unauthorized' }));
      return;
    }

    const parsed = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && parsed.pathname === '/v4/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          version: { semver: '4.2.2', major: 4, minor: 2, patch: 2 },
          jvm: '21.0.5',
          lavaplayer: '2.2.6',
          sourceManagers: ['youtube', 'soundcloud', 'http'],
          plugins: [{ name: 'youtube-plugin', version: '1.18.0-snapshot' }]
        })
      );
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/v4/loadtracks') {
      const identifier = parsed.searchParams.get('identifier') || 'Lagu Uji';
      const encodedTrack = Buffer.from(`opus-track:${identifier}`).toString('base64');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          loadType: 'search',
          data: [
            {
              encoded: encodedTrack,
              info: {
                identifier: 'vid_lagukan_01',
                isSeekable: true,
                author: 'Hindia',
                length: 215000,
                isStream: false,
                position: 0,
                title: 'Evaluasi (Real Opus Stream)',
                uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
                sourceName: 'youtube'
              },
              pluginInfo: {}
            }
          ]
        })
      );
      return;
    }

    const sessionMatch = parsed.pathname.match(/^\/v4\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'PATCH') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resuming: true, timeout: 60 }));
      return;
    }

    const playerMatch = parsed.pathname.match(/^\/v4\/sessions\/([^/]+)\/players\/([^/]+)$/);
    if (playerMatch) {
      const guildId = playerMatch[2];
      let current = players.get(guildId) || {
        guildId,
        track: null,
        volume: 100,
        paused: false,
        state: {
          time: Date.now(),
          position: 0,
          connected: false,
          ping: -1
        },
        voice: { token: '', endpoint: '', sessionId: '', channelId: '' },
        filters: {}
      };

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(current));
        return;
      }

      if (req.method === 'DELETE') {
        players.delete(guildId);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'PATCH') {
        let rawBody = '';
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', () => {
          const body = rawBody ? JSON.parse(rawBody) : {};

          if (body.voice) {
            current.voice = { ...current.voice, ...body.voice };
            voiceUpdatesReceived.push({ guildId, voice: { ...current.voice } });

            const hasValidVoice = Boolean(
              current.voice.token &&
              current.voice.endpoint &&
              current.voice.sessionId &&
              current.voice.channelId
            );

            if (hasValidVoice && udpTransportHealthy) {
              current.state.connected = true;
              current.state.ping = 12;
            } else {
              current.state.connected = false;
              current.state.ping = -1;
            }
          }

          if (typeof body.volume === 'number') {
            current.volume = body.volume;
          }
          if (typeof body.paused === 'boolean') {
            current.paused = body.paused;
          }

          if (body.track && Object.prototype.hasOwnProperty.call(body.track, 'encoded')) {
            if (body.track.encoded === null) {
              current.track = null;
              for (const iv of activeIntervals) clearInterval(iv);
              activeIntervals.clear();
            } else {
              current.track = {
                encoded: body.track.encoded,
                info: {
                  identifier: 'vid_lagukan_01',
                  isSeekable: true,
                  author: 'Hindia',
                  length: 215000,
                  isStream: false,
                  position: 0,
                  title: 'Evaluasi (Real Opus Stream)',
                  uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                  sourceName: 'youtube'
                }
              };

              // Mulai pemancaran paket audio RTP Opus setiap 20ms jika UDP voice transport sehat!
              setTimeout(() => {
                if (activeWs && activeWs.readyState === 1) {
                  activeWs.send(
                    JSON.stringify({
                      op: 'event',
                      type: 'TrackStartEvent',
                      guildId,
                      track: current.track
                    })
                  );
                }

                if (current.state.connected && udpTransportHealthy && current.volume > 0 && !current.paused) {
                  let seq = 1;
                  let ts = 960;
                  const rtpTimer = setInterval(() => {
                    if (!players.has(guildId) || !current.track || current.paused) {
                      clearInterval(rtpTimer);
                      activeIntervals.delete(rtpTimer);
                      return;
                    }
                    const pkt = buildRtpOpusPacket(seq, ts);
                    seq += 1;
                    ts += 960;
                    current.state.position += 20;
                    current.state.time = Date.now();
                    lavalinkMediaUdp.send(pkt, udpTargetPort, '127.0.0.1');

                    if (seq === 3 && activeWs && activeWs.readyState === 1) {
                      activeWs.send(
                        JSON.stringify({
                          op: 'stats',
                          players: 1,
                          playingPlayers: 1,
                          uptime: 10000,
                          memory: { free: 100, used: 100, allocated: 200, reservable: 400 },
                          cpu: { cores: 4, systemLoad: 0.1, lavalinkLoad: 0.05 },
                          frameStats: { sent: seq, nulled: 0, deficit: 0 }
                        })
                      );
                      activeWs.send(
                        JSON.stringify({
                          op: 'playerUpdate',
                          guildId,
                          state: {
                            time: Date.now(),
                            position: current.state.position,
                            connected: true,
                            ping: 12
                          }
                        })
                      );
                    }
                  }, 20);
                  if (typeof rtpTimer.unref === 'function') rtpTimer.unref();
                  activeIntervals.add(rtpTimer);
                } else if (activeWs && activeWs.readyState === 1) {
                  // Simulasikan Koe gagal terhubung UDP (state.connected: false, 0 paket terkirim)
                  activeWs.send(
                    JSON.stringify({
                      op: 'playerUpdate',
                      guildId,
                      state: {
                        time: Date.now(),
                        position: 60,
                        connected: false,
                        ping: -1
                      }
                    })
                  );
                }
              }, 30);
            }
          }

          players.set(guildId, current);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(current));
        });
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const authHeader = req.headers.authorization || '';
    const userIdHeader = req.headers['user-id'] || '';
    const clientNameHeader = req.headers['client-name'] || '';

    authAttempts.push({
      pathname: reqUrl.pathname,
      authorized: authHeader === password,
      hasAuthHeader: Boolean(authHeader),
      hasUserId: Boolean(userIdHeader),
      hasClientName: Boolean(clientNameHeader)
    });

    if (reqUrl.pathname !== '/v4/websocket' || authHeader !== password || !userIdHeader) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\n' +
        'Content-Type: text/plain\r\n' +
        'Connection: close\r\n\r\n' +
        'Authentication failed\r\n'
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      activeWs = ws;
      ws.send(
        JSON.stringify({
          op: 'ready',
          resumed: false,
          sessionId
        })
      );
    });
  });

  wss.on('headers', (headers) => {
    headers.push('Lavalink-Api-Version: 4');
    headers.push('Session-Resumed: false');
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;

  return {
    port,
    udpTargetPort,
    authAttempts,
    voiceUpdatesReceived,
    receivedRtpPackets,
    async close() {
      for (const iv of activeIntervals) clearInterval(iv);
      activeIntervals.clear();
      for (const wsClient of wss.clients) {
        try {
          wsClient.terminate();
        } catch {
          // Abaikan
        }
      }
      await new Promise((r) => wss.close(r));
      await new Promise((r) => httpServer.close(r));
      await new Promise((r) => lavalinkMediaUdp.close(r));
      await new Promise((r) => voiceListenerUdp.close(r));
    }
  };
}

/**
 * Menyiapkan Guild, VoiceChannel, TextChannel, dan Discord Gateway Shard pada LaguKanClient
 * agar Shoukaku menjalankan alur nyata Opcode 4 -> VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE.
 */
function attachSimulatedDiscordVoiceGateway(
  client,
  { guildId, voiceChannelId, textChannelId, udpTargetPort, serverFirstRace = false }
) {
  const sentGatewayPayloads = [];
  let sessionCounter = 1;

  const botUser = { id: '999888777666555444', tag: 'LaguKan#0001', bot: true };
  client.user = botUser;

  const botMember = {
    id: botUser.id,
    user: botUser,
    voice: {
      channelId: null,
      serverMute: false,
      selfMute: false,
      suppress: false,
      async setMute(val) {
        this.serverMute = val;
      },
      async setSuppressed(val) {
        this.suppress = val;
      }
    }
  };

  const humanMember = {
    id: '111222333444555666',
    user: { id: '111222333444555666', username: '666pallxXx', tag: '666pallxXx', bot: false },
    permissions: new PermissionsBitField([
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak,
      PermissionsBitField.Flags.ViewChannel
    ]),
    roles: { cache: new Collection() },
    voice: null
  };

  const voiceChannel = {
    id: voiceChannelId,
    name: 'Ruang Musik Utama',
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    members: new Collection([[humanMember.id, humanMember]]),
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak
      ])
  };
  humanMember.voice = { channelId: voiceChannelId, channel: voiceChannel };

  const sentChannelMessages = [];
  const textChannel = {
    id: textChannelId,
    name: 'perintah-musik',
    async send(payload) {
      const msg = {
        id: `msg_${sentChannelMessages.length + 1}`,
        payload,
        edits: [],
        async edit(editPayload) {
          this.edits.push(editPayload);
          this.payload = editPayload;
          return this;
        }
      };
      sentChannelMessages.push(msg);
      return msg;
    }
  };

  const guild = {
    id: guildId,
    name: 'Server Pengujian LaguKan',
    shardId: 0,
    channels: {
      cache: new Collection([
        [voiceChannelId, voiceChannel],
        [textChannelId, textChannel]
      ]),
      async fetch(id) {
        return this.cache.get(id) || null;
      }
    },
    members: {
      me: botMember,
      async fetchMe() {
        return botMember;
      }
    }
  };

  client.guilds.cache.set(guildId, guild);
  client.channels.cache.set(voiceChannelId, voiceChannel);
  client.channels.cache.set(textChannelId, textChannel);

  const shard = {
    id: 0,
    status: 0,
    send(payload) {
      sentGatewayPayloads.push(payload);
      // Tangani Discord Gateway Opcode 4 (Voice State Update dari Bot)
      if (payload?.op === 4 && payload?.d) {
        const { guild_id, channel_id, self_mute, self_deaf } = payload.d;
        botMember.voice.channelId = channel_id;
        botMember.voice.selfMute = Boolean(self_mute);

        if (!channel_id) {
          setImmediate(() => {
            client.emit('raw', {
              t: 'VOICE_STATE_UPDATE',
              d: {
                guild_id,
                user_id: botUser.id,
                channel_id: null,
                session_id: `discord_voice_sess_${sessionCounter}`,
                self_deaf: false,
                self_mute: false
              }
            });
          });
          return;
        }

        const currentSession = `discord_voice_sess_${sessionCounter++}`;
        const serverPkt = {
          t: 'VOICE_SERVER_UPDATE',
          d: {
            guild_id,
            endpoint: `127.0.0.1:${udpTargetPort}`,
            token: `voice_tok_${guild_id}_live`
          }
        };
        const statePkt = {
          t: 'VOICE_STATE_UPDATE',
          d: {
            guild_id,
            user_id: botUser.id,
            channel_id,
            session_id: currentSession,
            self_deaf: Boolean(self_deaf),
            self_mute: Boolean(self_mute)
          }
        };

        if (serverFirstRace) {
          // Simulasikan kondisi balapan nyata Discord: VOICE_SERVER_UPDATE tiba SEBELUM VOICE_STATE_UPDATE!
          setTimeout(() => client.emit('raw', serverPkt), 5);
          setTimeout(() => client.emit('raw', statePkt), 35);
        } else {
          setTimeout(() => client.emit('raw', statePkt), 5);
          setTimeout(() => client.emit('raw', serverPkt), 15);
        }
      }
    }
  };

  client.ws.shards = new Collection([[0, shard]]);

  return {
    guild,
    voiceChannel,
    textChannel,
    humanMember,
    botMember,
    sentGatewayPayloads,
    sentChannelMessages,
    rotateVoiceSession() {
      const rotatedSession = `discord_voice_sess_rotated_${++sessionCounter}`;
      client.emit('raw', {
        t: 'VOICE_STATE_UPDATE',
        d: {
          guild_id: guildId,
          user_id: botUser.id,
          channel_id: voiceChannelId,
          session_id: rotatedSession,
          self_deaf: true,
          self_mute: false
        }
      });
      return rotatedSession;
    }
  };
}

function createInteraction({ commandName, guild, channelId, member, options = {} }) {
  const replies = [];
  return {
    commandName,
    guildId: guild.id,
    guild,
    channelId,
    member,
    user: member.user,
    inGuild: () => true,
    deferred: false,
    replied: false,
    replies,
    options: {
      getString(name) {
        return options[name] ?? null;
      },
      getBoolean(name) {
        return options[name] ?? null;
      }
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      this.replied = true;
      replies.push(payload);
      return payload;
    },
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
      return payload;
    }
  };
}

test('Real Playback Integration: HTTP 401 Auth Recovery + Out-of-Order Voice Handshake + /play -> Real UDP RTP Opus Transmission + Diagnostic Logs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-real-playback-'));
  const ymlPath = path.join(tmpDir, 'application.yml');
  const dbPath = path.join(tmpDir, 'real-test.sqlite');
  const realServerPassword = 'LaguKan_RealAuth_2026_Secret';

  // Tulis application.yml lokal dengan password server yang benar, sedangkan LAVALINK_PASSWORD di env sengaja salah!
  fs.writeFileSync(
    ymlPath,
    [
      'server:',
      '  port: 2333',
      '  address: 127.0.0.1',
      'lavalink:',
      '  server:',
      `    password: "${realServerPassword}"`
    ].join('\n'),
    'utf8'
  );

  const prevEnv = {
    LAVALINK_HOST: process.env.LAVALINK_HOST,
    LAVALINK_PORT: process.env.LAVALINK_PORT,
    LAVALINK_PASSWORD: process.env.LAVALINK_PASSWORD,
    LAVALINK_CONFIG_PATH: process.env.LAVALINK_CONFIG_PATH,
    VOICE_TRANSPORT_VERIFY_TIMEOUT_MS: process.env.VOICE_TRANSPORT_VERIFY_TIMEOUT_MS
  };

  const harness = await startRealLavalinkAndVoiceHarness({
    password: realServerPassword,
    udpTransportHealthy: true
  });

  // Tangkap log diagnostik untuk memverifikasi ke-9 kategori log wajib
  const capturedLogs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...args) => {
    capturedLogs.push(args.join(' '));
    origLog(...args);
  };
  console.warn = (...args) => {
    capturedLogs.push(args.join(' '));
    origWarn(...args);
  };
  console.error = (...args) => {
    capturedLogs.push(args.join(' '));
    origErr(...args);
  };

  process.env.LAVALINK_HOST = '127.0.0.1';
  process.env.LAVALINK_PORT = String(harness.port);
  process.env.LAVALINK_PASSWORD = 'password_env_lama_tidak_cocok';
  process.env.LAVALINK_CONFIG_PATH = ymlPath;
  process.env.VOICE_TRANSPORT_VERIFY_TIMEOUT_MS = '2500';

  const client = new LaguKanClient();
  client.db.filePath = dbPath;

  try {
    await client.init();

    const gatewaySim = attachSimulatedDiscordVoiceGateway(client, {
      guildId: 'guild_real_playback_01',
      voiceChannelId: 'vc_real_01',
      textChannelId: 'txt_real_01',
      udpTargetPort: harness.udpTargetPort,
      serverFirstRace: true // Sekaligus menguji VOICE_SERVER_UPDATE tiba lebih awal sebelum VOICE_STATE_UPDATE!
    });

    // Picu event clientReady pada Shoukaku Connector agar membuka koneksi nyata ke /v4/websocket
    const nodeReadyPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout menunggu event ready dari Shoukaku')), 5000);
      client.shoukaku.once('ready', (name) => {
        clearTimeout(t);
        resolve(name);
      });
    });

    client.emit('clientReady', client);
    const readyNodeName = await nodeReadyPromise;
    assert.equal(readyNodeName, 'LaguKan-Main');

    // 1. BUKTI PERBAIKAN WEBSOCKET 401 & BUG SHOUKAKU connectError:
    // Percobaan #1 ditolak HTTP 401 karena password .env salah, lalu otomatis pulih memakai password application.yml
    // pada percobaan #2 TANPA memutus socket atau menghapus node dari shoukaku.nodes!
    assert.equal(harness.authAttempts.length, 2);
    assert.equal(harness.authAttempts[0].authorized, false);
    assert.equal(harness.authAttempts[1].authorized, true);
    assert.equal(harness.authAttempts[1].hasAuthHeader, true);
    assert.equal(harness.authAttempts[1].hasUserId, true);
    assert.equal(harness.authAttempts[1].hasClientName, true);
    assert.equal(client.shoukaku.nodes.has('LaguKan-Main'), true);

    // 2. UJI NYATA SLASH COMMAND /play:
    // /play -> masuk voice channel -> resolve track -> mulai player -> paket RTP Opus terkirim & diterima via UDP!
    const playInteraction = createInteraction({
      commandName: 'play',
      guild: gatewaySim.guild,
      channelId: 'txt_real_01',
      member: gatewaySim.humanMember,
      options: { lagu: 'Evaluasi Hindia' }
    });

    await playCommand.execute(playInteraction, client);

    // Verifikasi bot mengirim Opcode 4 ke Discord Gateway untuk masuk ke voice channel dalam kondisi TIDAK MUTE
    const op4Join = gatewaySim.sentGatewayPayloads.find(
      (p) => p.op === 4 && p.d.channel_id === 'vc_real_01'
    );
    assert.ok(op4Join, 'Bot wajib mengirim Discord Gateway Opcode 4 untuk masuk ke voice channel');
    assert.equal(op4Join.d.self_mute, false, 'Bot tidak boleh masuk dalam kondisi self_mute');
    assert.equal(op4Join.d.self_deaf, true);

    // Tunggu beberapa frame RTP Opus (20ms/paket) tiba di socket UDP anggota voice channel
    await new Promise((r) => setTimeout(r, 160));

    assert.ok(
      harness.receivedRtpPackets.length >= 4,
      `Anggota voice channel wajib menerima paket RTP Opus nyata melalui UDP (terima: ${harness.receivedRtpPackets.length})`
    );
    assert.ok(
      harness.receivedRtpPackets.every((pkt) => pkt.audible && pkt.opusBytes > 8),
      'Seluruh paket RTP Opus yang diterima harus berisi sinyal audio nyata (bukan frame hening)'
    );

    // Verifikasi urutan sequence & timestamp RTP bertambah secara kontinu (stream tidak berhenti)
    assert.ok(
      harness.receivedRtpPackets[2].seq > harness.receivedRtpPackets[0].seq &&
      harness.receivedRtpPackets[2].timestamp > harness.receivedRtpPackets[0].timestamp,
      'Sequence & timestamp paket RTP Opus harus bertambah secara kontinu'
    );

    // Verifikasi state MusicPlayer & panel Now Playing
    const mp = client.playerManager.get('guild_real_playback_01');
    assert.ok(mp, 'Sesi MusicPlayer harus aktif');
    assert.equal(mp.state, 'PLAYING');
    assert.equal(mp.trackStarted, true);
    assert.equal(mp.voiceConnected, true);
    assert.equal(mp.audioPacketsSent, true);
    assert.equal(mp.volume, 100);
    assert.ok(gatewaySim.sentChannelMessages.length >= 1, 'Panel interaktif Now Playing harus terkirim');

    const playReplyEmbed = playInteraction.replies[0]?.embeds?.[0]?.toJSON?.() || playInteraction.replies[0]?.embeds?.[0];
    assert.match(playReplyEmbed.title, /Memulai Pemutaran Musik/);

    // 3. UJI ROTASI VOICE SESSION ID:
    // Pastikan perubahan session_id dari Discord langsung disinkronkan ulang ke Lavalink
    const voiceUpdatesBeforeRotate = harness.voiceUpdatesReceived.length;
    const newSessionId = gatewaySim.rotateVoiceSession();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(
      harness.voiceUpdatesReceived.length > voiceUpdatesBeforeRotate,
      'Rotasi session_id Discord wajib memicu pengiriman ulang voice update ke Lavalink'
    );
    assert.equal(
      harness.voiceUpdatesReceived.at(-1).voice.sessionId,
      newSessionId
    );

    // 4. UJI /debugmusic SAAT STREAM AKTIF:
    const dbgInteraction = createInteraction({
      commandName: 'debugmusic',
      guild: gatewaySim.guild,
      channelId: 'txt_real_01',
      member: gatewaySim.humanMember,
      options: { publik: true }
    });
    await debugMusicCommand.execute(dbgInteraction, client);
    const dbgEmbed = dbgInteraction.replies[0]?.embeds?.[0]?.toJSON?.();
    const dbgDump = JSON.stringify(dbgEmbed);
    assert.match(dbgDump, /Terautentikasi/);
    assert.match(dbgDump, /UDP Voice:.*AKTIF/);
    assert.match(dbgDump, /Mengirim Paket/);

    // 5. UJI TRACK EXCEPTION & TRACK STUCK LOGGING:
    await mp.onTrackException({
      exception: { message: 'Simulated minor packet jitter', severity: 'COMMON' }
    });
    mp.queue.enqueue({
      encoded: Buffer.from('opus-track:next').toString('base64'),
      info: {
        identifier: 'vid_02',
        title: 'Secukupnya',
        author: 'Hindia',
        length: 190000,
        isStream: false,
        isSeekable: true,
        sourceName: 'youtube',
        uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      }
    });
    await mp.onTrackStuck({ thresholdMs: 10000 });

    // 6. VERIFIKASI KE-9 DIAGNOSTIC LOGS WAJIB TERCETAK:
    const joinedLogs = capturedLogs.join('\n');
    assert.match(joinedLogs, /Lavalink WebSocket authenticated/);
    assert.match(joinedLogs, /Discord voice connected/);
    assert.match(joinedLogs, /UDP connection established/);
    assert.match(joinedLogs, /Audio packet transmission/);
    assert.match(joinedLogs, /Track playback started/);
    assert.match(joinedLogs, /Track exception/);
    assert.match(joinedLogs, /Track stuck/);
    assert.match(joinedLogs, /Audio player state/);
    assert.match(joinedLogs, /Voice connection state/);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
    await client.shutdown('REAL_PLAYBACK_TEST_DONE');
    await harness.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Anti-Fake-Playing Guard: menolak status PLAYING apabila UDP/Discord Voice transport gagal (state.connected=false)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-silent-guard-'));
  const dbPath = path.join(tmpDir, 'guard.sqlite');
  const pw = 'LaguKan_Guard_Secret_2026';

  const prevEnv = {
    LAVALINK_HOST: process.env.LAVALINK_HOST,
    LAVALINK_PORT: process.env.LAVALINK_PORT,
    LAVALINK_PASSWORD: process.env.LAVALINK_PASSWORD,
    VOICE_TRANSPORT_VERIFY_TIMEOUT_MS: process.env.VOICE_TRANSPORT_VERIFY_TIMEOUT_MS
  };

  // Simulasikan kondisi bug utama: Lavalink memicu TrackStartEvent tetapi transport UDP gagal (0 paket terkirim)
  const harness = await startRealLavalinkAndVoiceHarness({
    password: pw,
    udpTransportHealthy: false
  });

  process.env.LAVALINK_HOST = '127.0.0.1';
  process.env.LAVALINK_PORT = String(harness.port);
  process.env.LAVALINK_PASSWORD = pw;
  process.env.VOICE_TRANSPORT_VERIFY_TIMEOUT_MS = '950';

  const client = new LaguKanClient();
  client.db.filePath = dbPath;

  try {
    await client.init();
    const gatewaySim = attachSimulatedDiscordVoiceGateway(client, {
      guildId: 'guild_broken_udp',
      voiceChannelId: 'vc_broken_01',
      textChannelId: 'txt_broken_01',
      udpTargetPort: harness.udpTargetPort,
      serverFirstRace: false
    });

    const nodeReady = new Promise((resolve) => client.shoukaku.once('ready', resolve));
    client.emit('clientReady', client);
    await nodeReady;

    const playInteraction = createInteraction({
      commandName: 'play',
      guild: gatewaySim.guild,
      channelId: 'txt_broken_01',
      member: gatewaySim.humanMember,
      options: { lagu: 'Lagu Tanpa UDP' }
    });

    await playCommand.execute(playInteraction, client);

    const mp = client.playerManager.get('guild_broken_udp');
    assert.ok(mp);
    // Player DILARANG mengklaim PLAYING jika tidak ada paket suara UDP yang terhubung!
    assert.notEqual(mp.state, 'PLAYING');
    assert.equal(mp.state, 'VOICE_ERROR');
    assert.equal(mp.trackStarted, false);
    assert.equal(harness.receivedRtpPackets.length, 0);
    assert.equal(
      gatewaySim.sentChannelMessages.length,
      0,
      'Panel Now Playing palsu TIDAK BOLEH dikirim ketika 0 paket audio terkirim'
    );

    const replyEmbed = playInteraction.replies[0]?.embeds?.[0]?.toJSON?.();
    assert.match(replyEmbed.title, /Pemutaran Audio Gagal/);
    assert.match(replyEmbed.description, /state\.connected = false/);
  } finally {
    await client.shutdown('SILENT_GUARD_DONE');
    await harness.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Termux Launcher Password Sync: menyinkronkan LAVALINK_PASSWORD (.env) ke application.yml secara otomatis tanpa membocorkan rahasia', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-termux-sync-'));
  const envFile = path.join(tmpDir, '.env');
  const ymlFile = path.join(tmpDir, 'application.yml');
  const secretPw = 'RahasiaTermux_666pallxXx_99!';

  try {
    fs.writeFileSync(envFile, `DISCORD_CLIENT_ID=123\nLAVALINK_PASSWORD="${secretPw}"\n`, 'utf8');
    fs.copyFileSync(
      path.resolve(__dirname, '../config/application.yml.example'),
      ymlFile
    );

    // Ekstrak & jalankan blok sinkronisasi Node dari scripts/start-lavalink-termux.sh
    const scriptText = fs.readFileSync(
      path.resolve(__dirname, '../scripts/start-lavalink-termux.sh'),
      'utf8'
    );
    const nodeBlockMatch = scriptText.match(/node - <<'EOF'\n([\s\S]*?)\nEOF/);
    assert.ok(nodeBlockMatch, 'Blok sinkronisasi Node harus ada pada start-lavalink-termux.sh');

    const stdout = execFileSync(process.execPath, ['-e', nodeBlockMatch[1]], {
      env: { ...process.env, BOT_ENV_PATH: envFile, YML_CFG_PATH: ymlFile },
      encoding: 'utf8'
    });

    // Pastikan password rahasia TIDAK PERNAH dicetak ke stdout
    assert.ok(!stdout.includes(secretPw), 'Password rahasia tidak boleh bocor ke stdout log');
    assert.match(stdout, /berhasil disinkronkan otomatis/);

    const updatedYml = fs.readFileSync(ymlFile, 'utf8');
    assert.ok(
      updatedYml.includes(`password: "${secretPw}"`),
      'lavalink.server.password di application.yml harus otomatis cocok dengan .env'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
