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

class FakeShoukakuPlayer extends EventEmitter {
  constructor(node) {
    super();
    this.node = node;
    this.track = null;
    this.paused = false;
    this.volume = 80;
    this.ping = 28;
    this.filters = {};
  }
  async playTrack(payload) {
    this.track = payload.track.encoded;
    this.paused = Boolean(payload.paused);
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

function createMockInteraction(overrides = {}) {
  const voiceChannel = overrides.voiceChannel ?? {
    id: 'vc-main',
    name: 'Musik Umum',
    type: ChannelType.GuildVoice,
    full: false,
    isVoiceBased: () => true,
    members: { filter: () => ({ size: 1 }) },
    permissionsFor: () => ({ has: () => true })
  };

  const guild = {
    id: 'guild-main',
    name: 'Server Komunitas Indonesia',
    shardId: 0,
    ownerId: 'user-admin',
    memberCount: 250,
    premiumTier: 2,
    premiumSubscriptionCount: 8,
    createdTimestamp: Date.now() - 86400000 * 100,
    iconURL: () => null,
    channels: {
      cache: new Collection([
        ['vc-main', voiceChannel],
        ['tc-main', { id: 'tc-main', type: ChannelType.GuildText, isVoiceBased: () => false }]
      ]),
      fetch: async (id) => (id === 'vc-main' ? voiceChannel : null)
    },
    members: {
      me: {
        voice: { channelId: overrides.botInVoice ? 'vc-main' : null, suppress: false }
      }
    }
  };

  const state = {
    deferred: false,
    replied: false,
    lastPayload: null
  };

  const optionsMap = overrides.options || {};

  return {
    id: `inter-${Math.random().toString(36).slice(2, 8)}`,
    guildId: guild.id,
    channelId: 'tc-main',
    guild,
    inGuild: () => true,
    user: { id: 'user-admin', tag: '666pallxXx' },
    member: {
      voice: { channel: voiceChannel },
      permissions: {
        has: (flag) =>
          flag === PermissionFlagsBits.Administrator ||
          flag === PermissionFlagsBits.ManageGuild
      },
      roles: { cache: new Map() }
    },
    options: {
      getString: (k) => optionsMap[k] ?? null,
      getInteger: (k) => (optionsMap[k] !== undefined ? optionsMap[k] : null),
      getBoolean: (k) => (optionsMap[k] !== undefined ? optionsMap[k] : null),
      getRole: (k) => optionsMap[k] ?? null,
      getChannel: (k) => optionsMap[k] ?? null,
      getSubcommand: () => optionsMap._sub ?? null
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
    fetchReply: async () => ({
      id: 'msg-1',
      edit: async () => {},
      createMessageComponentCollector: () => {
        const col = new EventEmitter();
        col.stop = () => {};
        return col;
      }
    }),
    _state: state
  };
}

test('End-to-end eksekusi seluruh Slash Command Playback, Queue, Voice, Utility, & Information', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-e2e-'));
  config.database.path = path.join(tmpDir, 'e2e.sqlite');

  const client = new LaguKanClient();

  try {
    await client.init();

    const fakeNode = {
      name: 'LaguKan-Main',
      state: Constants.State.CONNECTED,
      stats: {
        players: 1,
        playingPlayers: 1,
        uptime: 60000,
        memory: { used: 120 * 1024 * 1024, allocated: 256 * 1024 * 1024 },
        cpu: { lavalinkLoad: 0.05, systemLoad: 0.12 }
      },
      rest: {
        resolve: async (q) => ({
          loadType: LoadType.SEARCH,
          data: [
            {
              encoded: `enc-${q}`,
              info: {
                identifier: `id-${q}`,
                isSeekable: true,
                author: 'Hindia',
                length: 210000,
                isStream: false,
                position: 0,
                title: `Lagu ${q}`,
                uri: 'https://www.youtube.com/watch?v=test123',
                sourceName: 'youtube'
              }
            }
          ]
        })
      }
    };

    const fakeShoukakuPlayer = new FakeShoukakuPlayer(fakeNode);
    client.shoukaku.nodes.clear();
    client.shoukaku.nodes.set('LaguKan-Main', fakeNode);
    client.shoukaku.getIdealNode = () => fakeNode;
    client.shoukaku.joinVoiceChannel = async ({ guildId }) => {
      client.shoukaku.players.set(guildId, fakeShoukakuPlayer);
      return fakeShoukakuPlayer;
    };
    client.shoukaku.leaveVoiceChannel = async (guildId) => {
      client.shoukaku.players.delete(guildId);
    };

    const run = async (cmdName, options = {}, botInVoice = true) => {
      const inter = createMockInteraction({ options, botInVoice });
      await client.commands.get(cmdName).execute(inter, client);
      assert.ok(inter._state.lastPayload, `/${cmdName} harus menghasilkan respons`);
      return inter._state.lastPayload;
    };

    // 1. /join & /play (3 lagu)
    await run('join', {}, false);
    await run('play', { lagu: 'Evaluasi' });
    await run('play', { lagu: 'Secukupnya' });
    await run('play', { lagu: 'Rumah Ke Rumah' });

    // 2. /nowplaying, /pause, /resume, /seek, /volume, /replay
    await run('nowplaying');
    await run('pause');
    await run('resume');
    await run('seek', { waktu: '01:15' });
    await run('volume');
    await run('volume', { level: 95, simpan_default: true });
    await run('replay');

    // 3. /queue, /move, /shuffle, /loop, /filter
    await run('queue', { halaman: 1 });
    await run('move', { dari: 2, ke: 1 });
    await run('shuffle');
    await run('loop', { mode: 'queue' });
    await run('filter', { preset: 'nightcore' });
    await run('filter', { preset: 'off' });

    // 4. /saveplaylist, /playlist (list, view, addtrack, removetrack, delete), /loadplaylist
    await run('saveplaylist', { nama: 'Koleksi Malam', publik: true });
    await run('playlist', { _sub: 'list' });
    await run('playlist', { _sub: 'view', nama: 'Koleksi Malam' });
    await run('playlist', { _sub: 'addtrack', nama: 'Koleksi Malam' });
    await run('playlist', { _sub: 'removetrack', nama: 'Koleksi Malam', nomor: 1 });

    // 5. /skip, /previous, /jump, /remove, /clear
    await run('skip');
    await run('previous');
    await run('loadplaylist', { nama: 'Koleksi Malam', acak: false });
    await run('jump', { posisi: 1, simpan_yang_dilewati: true });
    await run('remove', { posisi: 1 });
    await run('clear');
    await run('playlist', { _sub: 'delete', nama: 'Koleksi Malam' });

    // 6. /247, /autoplay, /dj
    await run('247', { status: 'on' });
    await run('autoplay', { status: 'on' });
    await run('dj', { _sub: 'info' });
    await run('dj', { _sub: 'mode', status: 'on' });
    await run('dj', { _sub: 'reset' });

    // 7. /ping, /serverinfo, /stats, /stop, /disconnect
    await run('ping');
    await run('serverinfo');
    await run('stats');
    await run('stop');

    await run('join', {}, false);
    await run('disconnect');
  } finally {
    await client.shutdown('E2E_DONE');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
