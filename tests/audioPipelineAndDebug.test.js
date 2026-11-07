'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionFlagsBits, ChannelType } = require('discord.js');
const { LoadType, Constants } = require('shoukaku');

const { config } = require('../config/config');
const { LaguKanClient } = require('../src/client');
const {
  classifyTrackFailure,
  inspectLocalLavalinkConfig
} = require('../src/music/audioDiagnostics');

class AsyncLifecycleShoukakuPlayer extends EventEmitter {
  constructor(node, behaviorFn) {
    super();
    this.node = node;
    this._asyncLifecycle = true;
    this.track = null;
    this.paused = false;
    this.volume = 100;
    this.ping = 22;
    this.filters = {};
    this.playCalls = [];
    this.behaviorFn = behaviorFn;
  }

  async playTrack(payload) {
    this.track = payload.track.encoded;
    this.paused = Boolean(payload.paused);
    if (typeof payload.volume === 'number') {
      this.volume = payload.volume;
    }
    this.playCalls.push(payload);
    if (this.behaviorFn) {
      queueMicrotask(() => {
        this.behaviorFn(this, payload);
      });
    }
  }

  async setPaused(p) {
    this.paused = p;
  }

  async setGlobalVolume(v) {
    this.volume = v;
  }

  async seekTo() {}

  async stopTrack() {
    this.track = null;
  }

  async setFilters(f) {
    this.filters = f;
  }

  async clearFilters() {
    this.filters = {};
  }
}

function buildTestGuildAndInteraction(sentChannelMessages, options = {}) {
  const voiceChannel = {
    id: 'vc-termux-1',
    name: 'Ruang Musik ARM64',
    type: ChannelType.GuildVoice,
    full: false,
    isVoiceBased: () => true,
    members: { filter: () => ({ size: 1 }) },
    permissionsFor: () => ({ has: () => true })
  };

  const textChannel = {
    id: 'tc-termux-1',
    type: ChannelType.GuildText,
    isVoiceBased: () => false,
    send: async (payload) => {
      const msgObj = {
        id: `np-msg-${sentChannelMessages.length + 1}`,
        payload,
        edit: async (updated) => {
          msgObj.payload = updated;
          return msgObj;
        }
      };
      sentChannelMessages.push(msgObj);
      return msgObj;
    }
  };

  const guild = {
    id: 'guild-termux-1',
    name: 'Komunitas Termux Indonesia',
    shardId: 0,
    ownerId: 'user-dev',
    memberCount: 42,
    channels: {
      cache: new Collection([
        ['vc-termux-1', voiceChannel],
        ['tc-termux-1', textChannel]
      ]),
      fetch: async (id) => {
        if (id === 'vc-termux-1') return voiceChannel;
        if (id === 'tc-termux-1') return textChannel;
        return null;
      }
    },
    members: {
      me: {
        voice: { channelId: 'vc-termux-1', suppress: false }
      }
    }
  };

  const state = { deferred: false, replied: false, lastPayload: null };

  const interaction = {
    id: `inter-${Math.random().toString(36).slice(2, 8)}`,
    guildId: guild.id,
    channelId: textChannel.id,
    guild,
    inGuild: () => true,
    user: { id: 'user-dev', tag: '666pallxXx' },
    member: {
      voice: { channel: voiceChannel },
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.Administrator
      },
      roles: { cache: new Map() }
    },
    options: {
      getString: (k) => options[k] ?? null,
      getBoolean: (k) => (options[k] !== undefined ? options[k] : null),
      getInteger: (k) => (options[k] !== undefined ? options[k] : null)
    },
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    deferReply: async () => {
      state.deferred = true;
    },
    reply: async (payload) => {
      state.replied = true;
      state.lastPayload = payload;
      return payload;
    },
    editReply: async (payload) => {
      state.replied = true;
      state.lastPayload = payload;
      return payload;
    },
    _state: state
  };

  return { guild, voiceChannel, textChannel, interaction };
}

test('Validasi Konfigurasi Default ARM64 Opus Passthrough & application.yml.example', () => {
  // Volume default wajib 100 agar Lavaplayer OpusPacketRouter.passThrough berjalan Pure-Java tanpa JNI libconnector.so
  assert.equal(config.music.defaultVolume, 100);
  assert.equal(config.music.opusPassthroughVolume, 100);

  const exampleYamlPath = path.resolve(__dirname, '../config/application.yml.example');
  const prevEnv = process.env.LAVALINK_CONFIG_PATH;
  process.env.LAVALINK_CONFIG_PATH = exampleYamlPath;

  try {
    const inspected = inspectLocalLavalinkConfig();
    assert.equal(inspected.found, true);
    assert.equal(inspected.hasRemoteCipher, true);
    assert.equal(inspected.bufferDurationMs, 0);
    // Pastikan client AAC-only "IOS" TIDAK ada di daftar default Termux
    assert.equal(inspected.youtubeClients.includes('IOS'), false);
    // Pastikan client Opus utama tersedia
    assert.equal(inspected.youtubeClients.includes('ANDROID_VR'), true);
    assert.equal(inspected.youtubeClients.includes('ANDROID_MUSIC'), true);
    assert.equal(inspected.youtubeClients.includes('TVHTML5_SIMPLY'), true);
  } finally {
    if (prevEnv === undefined) delete process.env.LAVALINK_CONFIG_PATH;
    else process.env.LAVALINK_CONFIG_PATH = prevEnv;
  }

  // Klasifikasi tepat error nyata AacDecoderLibrary & WEB SABR
  const jniDiag = classifyTrackFailure({
    message: 'Something went wrong when decoding the track.',
    cause: 'NativeLibraryLoader.load() -> AacDecoderLibrary.getInstance()'
  });
  assert.equal(jniDiag.code, 'ANDROID_JNI_DECODER_UNSUPPORTED');
  assert.equal(jniDiag.isNativeJniFailure, true);

  const sabrDiag = classifyTrackFailure({
    message: 'Client [WEB]: No supported audio streams available.'
  });
  assert.equal(sabrDiag.code, 'YOUTUBE_SABR_NO_STREAMS');
});

test('Pipeline 9-Tahap: Now Playing ditahan sebelum TrackStartEvent & Fallback otomatis YouTube AacDecoderLibrary -> SoundCloud Opus', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-pipeline-'));
  config.database.path = path.join(tmpDir, 'pipeline.sqlite');

  const client = new LaguKanClient();
  const sentChannelMessages = [];

  try {
    await client.init();

    const fakeNode = {
      name: 'LaguKan-Main',
      state: Constants.State.CONNECTED,
      sessionId: 'sess-lavalink-real-1',
      reconnects: 0,
      stats: {
        players: 1,
        playingPlayers: 1,
        uptime: 120000,
        frameStats: { sent: 3000, nulled: 0, deficit: 0 },
        memory: { used: 90 * 1024 * 1024, allocated: 256 * 1024 * 1024 },
        cpu: { cores: 8, lavalinkLoad: 0.03, systemLoad: 0.1 }
      },
      rest: {
        getLavalinkInfo: async () => ({
          version: { semver: '4.2.2' },
          jvm: '21.0.6',
          lavaplayer: '2.2.6',
          sourceManagers: ['youtube', 'soundcloud', 'bandcamp', 'http'],
          filters: ['volume', 'equalizer'],
          plugins: [{ name: 'youtube-plugin', version: '2be8e542' }]
        }),
        resolve: async (identifier) => {
          if (identifier.startsWith('scsearch:')) {
            return {
              loadType: LoadType.SEARCH,
              data: [
                {
                  encoded: 'enc-sc-opus-251',
                  info: {
                    identifier: 'sc-track-99',
                    isSeekable: true,
                    author: 'Hindia',
                    length: 214000,
                    isStream: false,
                    position: 0,
                    title: 'Hindia - Evaluasi',
                    uri: 'https://soundcloud.com/hindia/evaluasi',
                    sourceName: 'soundcloud'
                  }
                }
              ]
            };
          }
          return {
            loadType: LoadType.SEARCH,
            data: [
              {
                encoded: 'enc-yt-aac-broken',
                info: {
                  identifier: 'yt-broken-1',
                  isSeekable: true,
                  author: 'Hindia - Topic',
                  length: 215000,
                  isStream: false,
                  position: 0,
                  title: 'Evaluasi (Official Audio)',
                  uri: 'https://www.youtube.com/watch?v=yt-broken-1',
                  sourceName: 'youtube'
                }
              }
            ]
          };
        }
      }
    };

    // Simulasikan skenario nyata Termux:
    // 1. Track YouTube gagal dengan AacDecoderLibrary.getInstance() -> TrackException + TrackEnd(loadFailed)
    //    Pastikan saat itu BELUM ADA pesan Now Playing yang dikirim!
    // 2. LaguKan otomatis beralih ke SoundCloud Ogg Opus pada Volume 100% -> TrackStartEvent sukses!
    let nowPlayingCountDuringFailure = -1;
    const asyncPlayer = new AsyncLifecycleShoukakuPlayer(fakeNode, (player, payload) => {
      if (payload.track.encoded === 'enc-yt-aac-broken') {
        nowPlayingCountDuringFailure = sentChannelMessages.length;
        player.emit('exception', {
          exception: {
            message: 'Client [TVHTML5]: Something went wrong when decoding the track.',
            severity: 'COMMON',
            cause: 'NativeLibraryLoader.load() -> AacDecoderLibrary.getInstance()'
          }
        });
        player.emit('end', { reason: 'loadFailed' });
        return;
      }

      if (payload.track.encoded === 'enc-sc-opus-251') {
        player.emit('start', { track: { encoded: payload.track.encoded } });
      }
    });

    const { guild, interaction } = buildTestGuildAndInteraction(sentChannelMessages, {
      lagu: 'Evaluasi Hindia'
    });

    client.guilds.cache.set(guild.id, guild);
    client.channels.cache.set('tc-termux-1', guild.channels.cache.get('tc-termux-1'));
    client.shoukaku.nodes.clear();
    client.shoukaku.nodes.set('LaguKan-Main', fakeNode);
    client.shoukaku.getIdealNode = () => fakeNode;
    client.shoukaku.connections.set(guild.id, {
      state: 1,
      channelId: 'vc-termux-1',
      sessionId: 'discord-voice-session-xyz',
      region: 'singapore',
      deafened: true,
      muted: false,
      serverUpdate: {
        endpoint: 'singapore1234.discord.media:443',
        token: 'SECRET_VOICE_TOKEN_DO_NOT_LEAK_99999'
      }
    });
    client.shoukaku.joinVoiceChannel = async ({ guildId }) => {
      client.shoukaku.players.set(guildId, asyncPlayer);
      return asyncPlayer;
    };
    client.shoukaku.leaveVoiceChannel = async (guildId) => {
      client.shoukaku.players.delete(guildId);
      client.shoukaku.connections.delete(guildId);
    };

    // Setel volume awal 80 di DB untuk membuktikan Self-Healing ke 100% saat JNI AacDecoderLibrary gagal!
    client.guildsRepo.setDefaultVolume(guild.id, 80);

    await client.commands.get('play').execute(interaction, client);

    // 1. Saat track pertama gagal, pesan Now Playing BELUM dikirim (0 pesan)
    assert.equal(nowPlayingCountDuringFailure, 0);

    // 2. Setelah fallback SoundCloud Opus memancarkan TrackStartEvent, tepat 1 pesan Now Playing terkirim
    assert.equal(sentChannelMessages.length, 1);
    const mp = client.playerManager.get(guild.id);
    assert.ok(mp);
    assert.equal(mp.trackStarted, true);
    assert.equal(mp.state, 'PLAYING');
    assert.equal(mp.volume, 100, 'Self-healing wajib mengunci volume ke 100% untuk Pure-Java Opus Passthrough');
    assert.equal(mp.currentTrack.info.sourceName, 'soundcloud');

    const playReplyStr = JSON.stringify(interaction._state.lastPayload);
    assert.match(playReplyStr, /Memulai Pemutaran Musik/);
    assert.match(playReplyStr, /soundcloud/i);

    // 3. Uji transisi lagu berikutnya saat lagu selesai (finished), pause, resume, skip, & reconnect
    const secondInter = buildTestGuildAndInteraction(sentChannelMessages, {
      lagu: 'https://soundcloud.com/hindia/secukupnya'
    }).interaction;
    fakeNode.rest.resolve = async () => ({
      loadType: LoadType.TRACK,
      data: {
        encoded: 'enc-sc-opus-second',
        info: {
          identifier: 'sc-track-100',
          isSeekable: true,
          author: 'Hindia',
          length: 205000,
          isStream: false,
          position: 0,
          title: 'Hindia - Secukupnya',
          uri: 'https://soundcloud.com/hindia/secukupnya',
          sourceName: 'soundcloud'
        }
      }
    });
    asyncPlayer.behaviorFn = (p, payload) => {
      p.emit('start', { track: { encoded: payload.track.encoded } });
    };

    await client.commands.get('play').execute(secondInter, client);
    assert.equal(mp.queue.size, 1);

    await mp.pause();
    assert.equal(mp.paused, true);
    assert.equal(mp.state, 'PAUSED');
    await mp.resume();
    assert.equal(mp.paused, false);
    assert.equal(mp.state, 'PLAYING');

    // Simulasikan lagu pertama selesai -> otomatis lanjut ke lagu kedua di antrean
    await mp.onTrackEnd({ reason: 'finished' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mp.currentTrack.info.title, 'Hindia - Secukupnya');
    assert.equal(mp.trackStarted, true);

    // 4. Uji /debugmusic & pastikan TIDAK ADA rahasia/token bocor!
    config.bot.token = 'FAKE_SECRET_BOT_TOKEN_FOR_REDACTION_CHECK';
    const debugInter = buildTestGuildAndInteraction(sentChannelMessages, { publik: true }).interaction;
    await client.commands.get('debugmusic').execute(debugInter, client);

    const debugEmbedStr = JSON.stringify(debugInter._state.lastPayload);
    assert.match(debugEmbedStr, /4\.2\.2/);
    assert.match(debugEmbedStr, /21\.0\.6/);
    assert.match(debugEmbedStr, /youtube-plugin/);
    assert.match(debugEmbedStr, /Pure-Java Opus Passthrough/);
    assert.match(debugEmbedStr, /ANDROID_JNI_DECODER_UNSUPPORTED/);
    assert.equal(debugEmbedStr.includes('SECRET_VOICE_TOKEN_DO_NOT_LEAK_99999'), false);
    assert.equal(debugEmbedStr.includes('FAKE_SECRET_BOT_TOKEN_FOR_REDACTION_CHECK'), false);

    // 5. Uji pemulihan otomatis saat Lavalink restart (recoverInterruptedPlayers)
    client.shoukaku.players.delete(guild.id);
    await client.playerManager.recoverInterruptedPlayers();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(client.shoukaku.players.has(guild.id), true);
    assert.equal(mp.currentTrack.info.title, 'Hindia - Secukupnya');
  } finally {
    await client.shutdown('PIPELINE_TEST_DONE');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Anti-Infinite-Loop & Zero Fake Now Playing saat seluruh sumber gagal didekode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-allfail-'));
  config.database.path = path.join(tmpDir, 'allfail.sqlite');

  const client = new LaguKanClient();
  const sentChannelMessages = [];

  try {
    await client.init();

    let resolveCount = 0;
    const fakeNode = {
      name: 'LaguKan-Main',
      state: Constants.State.CONNECTED,
      sessionId: 'sess-lavalink-fail',
      rest: {
        resolve: async (q) => {
          resolveCount += 1;
          return {
            loadType: LoadType.SEARCH,
            data: [
              {
                encoded: `enc-fail-${resolveCount}`,
                info: {
                  identifier: `id-fail-${resolveCount}`,
                  isSeekable: true,
                  author: 'Artis Uji',
                  length: 190000,
                  isStream: false,
                  position: 0,
                  title: `Lagu Uji ${q}`,
                  uri: 'https://www.youtube.com/watch?v=broken',
                  sourceName: q.startsWith('scsearch:') ? 'soundcloud' : 'youtube'
                }
              }
            ]
          };
        }
      }
    };

    const alwaysFailingPlayer = new AsyncLifecycleShoukakuPlayer(fakeNode, (player) => {
      player.emit('exception', {
        exception: {
          message: 'No supported audio streams available'
        }
      });
      player.emit('end', { reason: 'loadFailed' });
    });

    const { guild, interaction } = buildTestGuildAndInteraction(sentChannelMessages, {
      lagu: 'Lagu Rusak Total'
    });

    client.guilds.cache.set(guild.id, guild);
    client.channels.cache.set('tc-termux-1', guild.channels.cache.get('tc-termux-1'));
    client.shoukaku.nodes.clear();
    client.shoukaku.nodes.set('LaguKan-Main', fakeNode);
    client.shoukaku.getIdealNode = () => fakeNode;
    client.shoukaku.joinVoiceChannel = async ({ guildId }) => {
      client.shoukaku.players.set(guildId, alwaysFailingPlayer);
      return alwaysFailingPlayer;
    };
    client.shoukaku.leaveVoiceChannel = async (guildId) => {
      client.shoukaku.players.delete(guildId);
    };

    await client.commands.get('play').execute(interaction, client);

    // Pastikan percobaan dibatasi ketat (1 awal + maks 2 fallback = 3 playTrack) -> TIDAK loop tak terbatas!
    assert.ok(alwaysFailingPlayer.playCalls.length <= 3);

    // Pastikan TIDAK ADA embed Now Playing palsu yang dikirim ke channel!
    assert.equal(sentChannelMessages.length, 0);

    // Pastikan respons /play berupa pesan gagal yang jelas dalam Bahasa Indonesia
    const replyJson = JSON.stringify(interaction._state.lastPayload);
    assert.match(replyJson, /Pemutaran Audio Gagal/);

    const mp = client.playerManager.get(guild.id);
    assert.equal(mp.playing, false);
    assert.equal(mp.trackStarted, false);
    assert.equal(mp.state, 'IDLE');
  } finally {
    await client.shutdown('ALLFAIL_DONE');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
