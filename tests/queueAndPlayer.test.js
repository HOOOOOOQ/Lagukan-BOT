'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { PermissionFlagsBits } = require('discord.js');

const { QueueManager } = require('../src/music/queueManager');
const { MusicPlayer } = require('../src/music/musicPlayer');
const { buildMusicPlayerPayload } = require('../src/utils/embeds');
const {
  validateVoiceAccess,
  assertControlPermission
} = require('../src/utils/permissions');
const { handlePlayerButton } = require('../src/buttons/playerButtons');
const { ErrorCodes } = require('../src/utils/errorHandler');

function makeTrack(id, title, requesterId = 'user-1') {
  return {
    encoded: `encoded-${id}`,
    info: {
      identifier: id,
      isSeekable: true,
      author: 'Artis Test',
      length: 180000,
      isStream: false,
      position: 0,
      title,
      uri: `https://www.youtube.com/watch?v=${id}`,
      artworkUrl: null,
      sourceName: 'youtube'
    },
    requester: { id: requesterId, tag: `User#${requesterId}` },
    originalSource: 'youtube'
  };
}

test('QueueManager: isolasi antar guild, loop, move, remove, jump, dan previous history', () => {
  const qGuildA = new QueueManager('guild-A');
  const qGuildB = new QueueManager('guild-B');

  qGuildA.enqueueMany([
    makeTrack('1', 'Lagu Satu'),
    makeTrack('2', 'Lagu Dua'),
    makeTrack('3', 'Lagu Tiga'),
    makeTrack('4', 'Lagu Empat')
  ]);

  qGuildB.enqueue(makeTrack('99', 'Lagu Server B'));

  // Pastikan queue antar server tidak bercampur
  assert.equal(qGuildA.size, 4);
  assert.equal(qGuildB.size, 1);
  assert.equal(qGuildB.peek().info.title, 'Lagu Server B');

  // Move posisi 4 ke posisi 1
  qGuildA.move(4, 1);
  assert.equal(qGuildA.getAt(1).info.title, 'Lagu Empat');

  // Remove posisi 3
  const removed = qGuildA.remove(3);
  assert.equal(removed.info.title, 'Lagu Dua');
  assert.equal(qGuildA.size, 3);

  // Dequeue & Loop Track
  const current = qGuildA.dequeueNext(null);
  assert.equal(current.info.title, 'Lagu Empat');

  qGuildA.setLoopMode('track');
  const replayed = qGuildA.dequeueNext(current, { skipped: false });
  assert.equal(replayed.info.title, 'Lagu Empat');

  // Jika di-skip manual meski loop 'track', tetap maju ke lagu berikutnya
  const afterSkip = qGuildA.dequeueNext(current, { skipped: true });
  assert.equal(afterSkip.info.title, 'Lagu Satu');

  // Previous mengembalikan Lagu Empat dari riwayat dan menaruh Lagu Satu kembali di depan queue
  const prev = qGuildA.popPrevious(afterSkip);
  assert.equal(prev.info.title, 'Lagu Empat');
  assert.equal(qGuildA.peek().info.title, 'Lagu Satu');

  // Loop Queue menaruh lagu yang selesai kembali ke ekor antrean
  qGuildA.setLoopMode('queue');
  const nextFromLoopQueue = qGuildA.dequeueNext(prev, { skipped: false });
  assert.equal(nextFromLoopQueue.info.title, 'Lagu Satu');
  assert.equal(qGuildA.tracks[qGuildA.size - 1].info.title, 'Lagu Empat');

  // Jump langsung ke posisi 2
  const jumped = qGuildA.jump(2, true);
  assert.equal(jumped.info.title, 'Lagu Empat');
});

test('MusicPlayer & Interactive Embed: menampilkan 10 tombol kontrol dan merespons aksi', async () => {
  class MockShoukakuPlayer extends EventEmitter {
    constructor() {
      super();
      this.node = {};
      this.track = null;
      this.paused = false;
      this.volume = 80;
    }
    async playTrack(opts) {
      this.track = opts.track.encoded;
    }
    async setPaused(state) {
      this.paused = state;
    }
    async setGlobalVolume(vol) {
      this.volume = vol;
    }
    async seekTo() {}
    async stopTrack() {
      this.track = null;
    }
    async setFilters() {}
    async clearFilters() {}
  }

  const shoukakuPlayer = new MockShoukakuPlayer();
  const mockClient = {
    channels: { cache: new Map(), fetch: async () => null },
    sourceResolver: {
      ensureTrackResolved: async (_node, t) => t
    }
  };
  const mockManager = {
    destroy: async () => {}
  };

  const mp = new MusicPlayer({
    client: mockClient,
    manager: mockManager,
    guildId: 'guild-test',
    voiceChannelId: 'vc-1',
    textChannelId: null,
    shoukakuPlayer,
    guildSettings: { default_volume: 80, twenty_four_seven: 0, autoplay: 0 }
  });

  mp.queue.enqueueMany([
    makeTrack('a1', 'Lagu Utama', 'req-1'),
    makeTrack('a2', 'Lagu Kedua', 'req-2'),
    makeTrack('a3', 'Lagu Ketiga', 'req-2')
  ]);

  await mp.playIfIdle();
  assert.equal(mp.currentTrack.info.title, 'Lagu Utama');
  assert.equal(mp.playing, true);

  const payload = buildMusicPlayerPayload(mp);
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.components.length, 2);

  // Verifikasi total 10 tombol interaktif tersedia
  const allButtons = payload.components.flatMap((row) => row.components.map((b) => b.data.custom_id));
  assert.deepEqual(allButtons, [
    'music:previous',
    'music:pause',
    'music:resume',
    'music:skip',
    'music:stop',
    'music:shuffle',
    'music:loop',
    'music:voldown',
    'music:volup',
    'music:queue'
  ]);

  await mp.pause();
  assert.equal(mp.paused, true);
  await mp.resume();
  assert.equal(mp.paused, false);
  await mp.setVolume(110);
  assert.equal(mp.volume, 110);
  await mp.setFilter('bassboost');
  assert.equal(mp.activeFilterKey, 'bassboost');

  // Uji klik tombol music:voldown melalui handlePlayerButton
  const fakeVoiceChannel = {
    id: 'vc-1',
    members: { filter: () => ({ size: 2 }) }
  };
  let deferred = false;
  const buttonInteraction = {
    customId: 'music:voldown',
    guildId: 'guild-test',
    inGuild: () => true,
    guild: { members: { me: { voice: { channelId: 'vc-1' } } } },
    user: { id: 'req-1' },
    member: {
      voice: { channel: fakeVoiceChannel },
      permissions: { has: () => false },
      roles: { cache: new Map() }
    },
    deferUpdate: async () => {
      deferred = true;
    }
  };

  await handlePlayerButton(buttonInteraction, {
    playerManager: { get: () => mp },
    guildsRepo: { getSettings: () => ({ dj_enabled: 1, dj_role_id: 'dj-role' }) }
  });

  assert.equal(deferred, true);
  assert.equal(mp.volume, 100);

  mp.cleanupTimersAndListeners();
});

test('Permissions & DJ Mode: mencegah kontrol sembarangan saat DJ Mode aktif & menolak channel berbeda', () => {
  const twoHumansMembers = {
    filter: () => ({ size: 2 })
  };

  const botVoiceChannelId = 'vc-musik-1';
  const otherVoiceChannel = { id: 'vc-lain-2', members: twoHumansMembers };
  const sameVoiceChannel = { id: botVoiceChannelId, members: twoHumansMembers };

  // 1. Pengguna belum di voice channel -> USER_NOT_IN_VOICE
  assert.throws(
    () =>
      validateVoiceAccess(
        {
          inGuild: () => true,
          guild: { members: { me: { voice: { channelId: botVoiceChannelId } } } },
          member: { voice: { channel: null } }
        },
        { voiceChannelId: botVoiceChannelId }
      ),
    (err) => err.code === ErrorCodes.USER_NOT_IN_VOICE
  );

  // 2. Pengguna berada di voice channel berbeda -> DIFFERENT_VOICE_CHANNEL
  assert.throws(
    () =>
      validateVoiceAccess(
        {
          inGuild: () => true,
          guild: { members: { me: { voice: { channelId: botVoiceChannelId } } } },
          member: { voice: { channel: otherVoiceChannel } }
        },
        { voiceChannelId: botVoiceChannelId }
      ),
    (err) => err.code === ErrorCodes.DIFFERENT_VOICE_CHANNEL
  );

  const mockMusicPlayer = {
    currentTrack: { requester: { id: 'requester-99' } }
  };
  const djSettingsOn = { dj_enabled: 1, dj_role_id: 'role-dj-1' };

  // 3. Pengguna biasa mencoba /stop saat DJ Mode ON -> ditolak (PERMISSION_DENIED)
  assert.throws(
    () =>
      assertControlPermission(
        {
          user: { id: 'random-user' },
          member: {
            voice: { channel: sameVoiceChannel },
            permissions: { has: () => false },
            roles: { cache: new Map() }
          }
        },
        mockMusicPlayer,
        djSettingsOn,
        'queue_manage'
      ),
    (err) => err.code === ErrorCodes.PERMISSION_DENIED
  );

  // 4. Requester lagu mengontrol lagunya sendiri (scope 'track') -> DIIZINKAN
  assert.equal(
    assertControlPermission(
      {
        user: { id: 'requester-99' },
        member: {
          voice: { channel: sameVoiceChannel },
          permissions: { has: () => false },
          roles: { cache: new Map() }
        }
      },
      mockMusicPlayer,
      djSettingsOn,
      'track'
    ),
    true
  );

  // 5. Pemilik Role DJ mengontrol queue_manage -> DIIZINKAN
  assert.equal(
    assertControlPermission(
      {
        user: { id: 'dj-user' },
        member: {
          voice: { channel: sameVoiceChannel },
          permissions: { has: () => false },
          roles: { cache: new Map([['role-dj-1', { id: 'role-dj-1' }]]) }
        }
      },
      mockMusicPlayer,
      djSettingsOn,
      'queue_manage'
    ),
    true
  );

  // 6. Administrator -> DIIZINKAN
  assert.equal(
    assertControlPermission(
      {
        user: { id: 'admin-user' },
        member: {
          voice: { channel: sameVoiceChannel },
          permissions: {
            has: (flag) => flag === PermissionFlagsBits.Administrator
          },
          roles: { cache: new Map() }
        }
      },
      mockMusicPlayer,
      djSettingsOn,
      'admin'
    ),
    true
  );
});
