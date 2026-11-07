'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LoadType } = require('shoukaku');

const {
  classifyInput,
  SourceResolver
} = require('../src/music/sourceResolver');
const { findAutoplayTrack } = require('../src/music/autoplay');
const {
  formatDuration,
  parseTimeInput,
  createProgressBar,
  formatSourceLabel
} = require('../src/utils/formatters');
const {
  ErrorCodes,
  classifyError
} = require('../src/utils/errorHandler');
const { RateLimiter } = require('../src/utils/rateLimiter');
const logger = require('../src/utils/logger');

test('classifyInput: memvalidasi YouTube, YT Music, Spotify, SoundCloud, Audio URL, SSRF, & Unsupported', () => {
  const yt = classifyInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(yt.type, 'youtube');

  const ytm = classifyInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(ytm.type, 'youtube_music');

  const sp = classifyInput('https://open.spotify.com/intl-id/track/4cOdK2wGLETKBW3PvgPWqT?si=abc');
  assert.equal(sp.type, 'spotify');
  assert.equal(sp.spotifyType, 'track');
  assert.equal(sp.spotifyId, '4cOdK2wGLETKBW3PvgPWqT');

  const spUri = classifyInput('spotify:album:1DFixLWuPkv3KT3TnV35m3');
  assert.equal(spUri.type, 'spotify');
  assert.equal(spUri.spotifyType, 'album');

  const sc = classifyInput('https://soundcloud.com/artist/song-name');
  assert.equal(sc.type, 'soundcloud');

  const direct = classifyInput('https://cdn.example.org/music/sample.mp3');
  assert.equal(direct.type, 'direct_audio');

  const search = classifyInput('Hindia Evaluasi');
  assert.equal(search.type, 'search');
  assert.equal(search.query, 'Hindia Evaluasi');

  // Tolak IP lokal (proteksi SSRF)
  assert.throws(
    () => classifyInput('http://127.0.0.1:8080/stream.mp3'),
    (err) => err.code === ErrorCodes.INVALID_URL
  );
  assert.throws(
    () => classifyInput('http://192.168.1.50/audio.mp3'),
    (err) => err.code === ErrorCodes.INVALID_URL
  );

  // Tolak protokol berbahaya / tidak didukung
  assert.throws(
    () => classifyInput('ftp://files.example.com/lagu.mp3'),
    (err) => err.code === ErrorCodes.INVALID_URL
  );

  // Tolak platform tidak didukung
  assert.throws(
    () => classifyInput('https://www.netflix.com/watch/12345'),
    (err) => err.code === ErrorCodes.UNSUPPORTED_SOURCE
  );
  assert.throws(
    () => classifyInput('https://music.apple.com/id/album/test/12345'),
    (err) => err.code === ErrorCodes.UNSUPPORTED_SOURCE
  );
});

test('SourceResolver & Autoplay: pencocokan metadata Spotify ke audio Lavalink dan pencarian anti-duplikat', async () => {
  const resolver = new SourceResolver();
  // Simulasikan metadata album Spotify yang dikembalikan dari API
  resolver.getSpotifyAccessToken = async () => 'fake-spotify-token';
  resolver.fetchSpotifyViaApi = async () => ({
    kind: 'playlist',
    playlistName: 'Menari Dengan Bayangan — Hindia',
    items: [
      {
        title: 'Evaluasi',
        author: 'Hindia',
        length: 215000,
        artworkUrl: 'https://i.scdn.co/image/cover1',
        uri: 'https://open.spotify.com/track/111'
      },
      {
        title: 'Secukupnya',
        author: 'Hindia',
        length: 205000,
        artworkUrl: 'https://i.scdn.co/image/cover1',
        uri: 'https://open.spotify.com/track/222'
      }
    ]
  });

  const mockNode = {
    rest: {
      resolve: async (identifier) => {
        if (identifier.startsWith('https://open.spotify.com/')) {
          return { loadType: LoadType.EMPTY, data: {} };
        }
        if (identifier.includes('Evaluasi')) {
          return {
            loadType: LoadType.SEARCH,
            data: [
              {
                encoded: 'enc-evaluasi',
                info: {
                  identifier: 'yt-eval-1',
                  isSeekable: true,
                  author: 'Hindia',
                  length: 215200,
                  isStream: false,
                  position: 0,
                  title: 'Hindia - Evaluasi',
                  uri: 'https://music.youtube.com/watch?v=yt-eval-1',
                  sourceName: 'youtubemusic'
                }
              }
            ]
          };
        }
        if (identifier.includes('Secukupnya')) {
          return {
            loadType: LoadType.SEARCH,
            data: [
              {
                encoded: 'enc-secukupnya',
                info: {
                  identifier: 'yt-sec-2',
                  isSeekable: true,
                  author: 'Hindia',
                  length: 205000,
                  isStream: false,
                  position: 0,
                  title: 'Hindia - Secukupnya',
                  uri: 'https://music.youtube.com/watch?v=yt-sec-2',
                  sourceName: 'youtubemusic'
                }
              }
            ]
          };
        }
        return { loadType: LoadType.EMPTY, data: {} };
      }
    }
  };

  const resolvedAlbum = await resolver.resolve(
    mockNode,
    'https://open.spotify.com/album/1234567890abcdef',
    { id: 'u1', tag: 'Tester' }
  );

  assert.equal(resolvedAlbum.kind, 'playlist');
  assert.equal(resolvedAlbum.tracks.length, 2);
  // Lagu pertama langsung dicocokkan dengan sumber audio
  assert.equal(resolvedAlbum.tracks[0].encoded, 'enc-evaluasi');
  assert.equal(resolvedAlbum.tracks[0].originalSource, 'spotify-matched');
  assert.match(formatSourceLabel(resolvedAlbum.tracks[0].originalSource, resolvedAlbum.tracks[0].matchedVia), /Pencocokan Audio/);

  // Lagu kedua bersifat deferred dan dapat di-resolve tepat saat akan diputar
  assert.equal(resolvedAlbum.tracks[1].unresolved, true);
  const hydratedSecond = await resolver.ensureTrackResolved(mockNode, resolvedAlbum.tracks[1]);
  assert.equal(hydratedSecond.encoded, 'enc-secukupnya');
  assert.equal(hydratedSecond.unresolved, false);

  // Autoplay memilih lagu yang belum diputar (melewati yt-eval-1 yang sudah diputar)
  const autoNode = {
    rest: {
      resolve: async () => ({
        loadType: LoadType.SEARCH,
        data: [
          {
            encoded: 'enc-evaluasi',
            info: {
              identifier: 'yt-eval-1',
              title: 'Evaluasi',
              author: 'Hindia',
              length: 215000,
              isStream: false,
              sourceName: 'youtubemusic'
            }
          },
          {
            encoded: 'enc-rumah',
            info: {
              identifier: 'yt-rumah-3',
              title: 'Rumah Ke Rumah',
              author: 'Hindia',
              length: 250000,
              isStream: false,
              sourceName: 'youtubemusic'
            }
          }
        ]
      })
    }
  };

  const autoTrack = await findAutoplayTrack(autoNode, resolvedAlbum.tracks[0], []);
  assert.ok(autoTrack);
  assert.equal(autoTrack.info.identifier, 'yt-rumah-3');
});

test('Formatters, ErrorHandler, RateLimiter, & Redaksi Keamanan Token di Logger', () => {
  assert.equal(formatDuration(95000), '01:35');
  assert.equal(formatDuration(3661000), '01:01:01');
  assert.equal(formatDuration(0, true), '🔴 LIVE');

  assert.equal(parseTimeInput('90'), 90000);
  assert.equal(parseTimeInput('02:15'), 135000);
  assert.equal(parseTimeInput('1:02:03'), 3723000);
  assert.equal(parseTimeInput('2m30s'), 150000);
  assert.equal(parseTimeInput('99:99'), null);
  assert.equal(parseTimeInput('bukan-angka'), null);

  const bar = createProgressBar(60000, 120000, 12, false);
  assert.match(bar, /50%/);

  // Klasifikasi error Discord & Lavalink
  assert.equal(classifyError({ code: 10062 }).code, ErrorCodes.INTERACTION_EXPIRED);
  assert.equal(classifyError({ status: 401, message: 'Unauthorized' }).code, ErrorCodes.LAVALINK_AUTH_FAILED);
  assert.equal(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:2333')).code, ErrorCodes.LAVALINK_OFFLINE);
  assert.equal(classifyError({ status: 429 }).code, ErrorCodes.RATE_LIMITED);

  // RateLimiter
  const rl = new RateLimiter();
  assert.equal(rl.check('u1', 500).limited, false);
  assert.equal(rl.check('u1', 500).limited, true);
  rl.destroy();

  // Redaksi token Discord otomatis (disusun dinamis agar tidak memicu false-positive secret scanner)
  const fakeDiscordToken = [
    Buffer.from('1234567890123456789').toString('base64url'),
    'GhIjKl',
    'MnOpQrStUvWxYz0123456789abcdef'
  ].join('.');
  const redacted = logger.redactSecrets(`Login gagal untuk token ${fakeDiscordToken}`);
  assert.equal(redacted.includes(fakeDiscordToken), false);
  assert.match(redacted, /\[REDACTED_DISCORD_TOKEN\]/);
});
