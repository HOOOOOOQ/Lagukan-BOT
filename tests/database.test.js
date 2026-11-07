'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseManager } = require('../src/database/database');
const { GuildRepository } = require('../src/database/guildRepository');
const { PlaylistRepository } = require('../src/database/playlistRepository');

test('SQLite DatabaseManager, GuildRepository & PlaylistRepository persist across restart', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-db-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');

  try {
    // Sesi 1: Tulis pengaturan server & playlist
    const db1 = new DatabaseManager(dbPath);
    await db1.init();
    assert.equal(typeof db1.ping(), 'number');

    const guilds1 = new GuildRepository(db1);
    const playlists1 = new PlaylistRepository(db1);

    guilds1.setDefaultVolume('guild-101', 125);
    guilds1.setDjMode('guild-101', true);
    guilds1.setDjRole('guild-101', 'role-dj-99');
    guilds1.setMusicChannel('guild-101', 'chan-music-1');
    guilds1.setTwentyFourSeven('guild-101', {
      enabled: true,
      voiceChannelId: 'vc-777',
      textChannelId: 'tc-888'
    });
    guilds1.setAutoplay('guild-101', true);

    const sampleTracks = [
      {
        encoded: 'enc-track-1',
        info: {
          title: 'Evaluasi',
          author: 'Hindia',
          uri: 'https://www.youtube.com/watch?v=abc123',
          identifier: 'abc123',
          length: 215000,
          sourceName: 'youtube'
        }
      },
      {
        encoded: 'enc-track-2',
        info: {
          title: 'Secukupnya',
          author: 'Hindia',
          uri: 'https://www.youtube.com/watch?v=def456',
          identifier: 'def456',
          length: 205000,
          sourceName: 'youtube'
        }
      }
    ];

    const saved = playlists1.savePlaylist({
      name: 'Favorit Indie',
      ownerId: 'user-1',
      ownerTag: '666pallxXx',
      guildId: 'guild-101',
      isPublic: true,
      tracks: sampleTracks
    });

    assert.equal(saved.trackCount, 2);
    assert.equal(saved.overwritten, false);

    // Tutup database (simulasi bot dimatikan)
    db1.close();
    assert.equal(fs.existsSync(dbPath), true);

    // Sesi 2: Buka kembali file database yang sama (simulasi bot dinyalakan ulang)
    const db2 = new DatabaseManager(dbPath);
    await db2.init();

    const guilds2 = new GuildRepository(db2);
    const playlists2 = new PlaylistRepository(db2);

    const restoredSettings = guilds2.getSettings('guild-101');
    assert.equal(restoredSettings.default_volume, 125);
    assert.equal(restoredSettings.dj_enabled, 1);
    assert.equal(restoredSettings.dj_role_id, 'role-dj-99');
    assert.equal(restoredSettings.music_channel_id, 'chan-music-1');
    assert.equal(restoredSettings.twenty_four_seven, 1);
    assert.equal(restoredSettings.voice_channel_id, 'vc-777');
    assert.equal(restoredSettings.autoplay, 1);

    const g247 = guilds2.getTwentyFourSevenGuilds();
    assert.equal(g247.length, 1);
    assert.equal(g247[0].guild_id, 'guild-101');

    // Akses oleh user lain di server yang sama (karena isPublic = true)
    const foundPublic = playlists2.findAccessiblePlaylist('user-2', 'guild-101', 'favorit indie');
    assert.ok(foundPublic);
    assert.equal(foundPublic.name, 'Favorit Indie');

    // Tambah lagu & hapus lagu urutan 1
    playlists2.addTrack('user-1', 'Favorit Indie', {
      encoded: 'enc-track-3',
      info: {
        title: 'Rumah Ke Rumah',
        author: 'Hindia',
        length: 260000,
        sourceName: 'youtube'
      }
    });

    const afterAdd = playlists2.getTracks(foundPublic.id);
    assert.equal(afterAdd.length, 3);

    playlists2.removeTrack('user-1', 'Favorit Indie', 1);
    const afterRemove = playlists2.getTracks(foundPublic.id);
    assert.equal(afterRemove.length, 2);
    assert.equal(afterRemove[0].position, 1);
    assert.equal(afterRemove[0].title, 'Secukupnya');
    assert.equal(afterRemove[1].position, 2);
    assert.equal(afterRemove[1].title, 'Rumah Ke Rumah');

    const counts = playlists2.getGlobalCounts();
    assert.equal(counts.playlists, 1);
    assert.equal(counts.tracks, 2);

    playlists2.deletePlaylist('user-1', 'Favorit Indie');
    assert.equal(playlists2.getGlobalCounts().playlists, 0);

    db2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
