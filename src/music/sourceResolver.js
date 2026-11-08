'use strict';

const { LoadType } = require('shoukaku');
const { config } = require('../../config/config');
const { AppError, ErrorCodes } = require('../utils/errorHandler');
const logger = require('../utils/logger').child('SourceResolver');

const SPOTIFY_URL_REGEX =
  /^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/i;

const SPOTIFY_URI_REGEX = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)$/i;

const DIRECT_AUDIO_EXT_REGEX = /\.(mp3|flac|wav|ogg|opus|m4a|aac|webm|m3u8)(\?.*)?$/i;

const UNSUPPORTED_DOMAINS = [
  'netflix.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'music.apple.com',
  'itunes.apple.com',
  'deezer.com',
  'tidal.com',
  'joox.com'
];

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number.parseInt(match172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Mengklasifikasikan input pengguna (URL platform spesifik atau kata kunci pencarian).
 */
function classifyInput(rawQuery) {
  const input = String(rawQuery || '').trim();
  if (!input) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Masukkan judul lagu atau URL musik yang ingin diputar.',
      { isWarning: true }
    );
  }

  if (input.length > 500) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Panjang input pencarian atau URL maksimal 500 karakter.',
      { isWarning: true }
    );
  }

  // Konversi URI aplikasi Spotify (spotify:track:xxx) ke URL HTTPS standar
  const spotifyUriMatch = input.match(SPOTIFY_URI_REGEX);
  if (spotifyUriMatch) {
    const [, spotifyType, spotifyId] = spotifyUriMatch;
    return {
      type: 'spotify',
      url: `https://open.spotify.com/${spotifyType.toLowerCase()}/${spotifyId}`,
      spotifyType: spotifyType.toLowerCase(),
      spotifyId
    };
  }

  // Deteksi protokol non-HTTP/HTTPS yang mencurigakan atau tidak didukung
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input) && !/^https?:\/\//i.test(input)) {
    throw new AppError(
      ErrorCodes.INVALID_URL,
      'Protokol URL tidak valid. Gunakan URL `http://` atau `https://` yang didukung.'
    );
  }

  // Jika input terlihat seperti URL tanpa spasi
  if (/^https?:\/\//i.test(input)) {
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new AppError(
        ErrorCodes.INVALID_URL,
        'Format URL tidak valid. Periksa kembali tautan yang Anda masukkan.'
      );
    }

    if (isPrivateOrLocalHost(parsed.hostname)) {
      throw new AppError(
        ErrorCodes.INVALID_URL,
        'URL jaringan lokal atau privat tidak diizinkan.'
      );
    }

    const host = parsed.hostname.toLowerCase();

    if (UNSUPPORTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
      throw new AppError(
        ErrorCodes.UNSUPPORTED_SOURCE,
        `Sumber **${host}** tidak didukung. LaguKan mendukung **YouTube, YouTube Music, Spotify (pencocokan metadata), SoundCloud, dan URL audio langsung**.`
      );
    }

    const spotifyMatch = input.match(SPOTIFY_URL_REGEX);
    if (spotifyMatch) {
      return {
        type: 'spotify',
        url: parsed.toString(),
        spotifyType: spotifyMatch[1].toLowerCase(),
        spotifyId: spotifyMatch[2]
      };
    }

    if (host.includes('spotify.com') || host.endsWith('spotify.link')) {
      throw new AppError(
        ErrorCodes.INVALID_URL,
        'Tautan Spotify tersebut tidak dikenali. Gunakan URL lagu (`track`), `album`, `playlist`, atau `artist` dari `open.spotify.com`.'
      );
    }

    if (host === 'music.youtube.com') {
      return { type: 'youtube_music', url: parsed.toString() };
    }

    if (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtu.be'
    ) {
      return { type: 'youtube', url: parsed.toString() };
    }

    if (
      host === 'soundcloud.com' ||
      host.endsWith('.soundcloud.com')
    ) {
      return { type: 'soundcloud', url: parsed.toString() };
    }

    if (host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) {
      return { type: 'bandcamp', url: parsed.toString() };
    }

    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      return { type: 'vimeo', url: parsed.toString() };
    }

    if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
      return { type: 'twitch', url: parsed.toString() };
    }

    if (DIRECT_AUDIO_EXT_REGEX.test(parsed.pathname)) {
      return { type: 'direct_audio', url: parsed.toString() };
    }

    return { type: 'generic_url', url: parsed.toString(), host };
  }

  // Dukungan prefix pencarian eksplisit seperti "scsearch:Hindia" atau "bcsearch:Lofi"
  const explicitPrefixMatch = input.match(/^(scsearch|bcsearch|ytmsearch|ytsearch|spsearch|dzsearch):(.+)$/i);
  if (explicitPrefixMatch) {
    const cleanExplicitQuery = explicitPrefixMatch[2].trim();
    if (!cleanExplicitQuery) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Masukkan kata kunci lagu setelah prefix pencarian.',
        { isWarning: true }
      );
    }
    return {
      type: 'search',
      explicitPrefix: explicitPrefixMatch[1].toLowerCase(),
      query: cleanExplicitQuery
    };
  }

  // Deteksi percobaan URL rusak seperti "http://..." dengan spasi atau "www.contoh"
  if (/^(https?:\/|www\.\S+\.\S+)/i.test(input) && !input.includes(' ')) {
    throw new AppError(
      ErrorCodes.INVALID_URL,
      'Format URL tidak lengkap. Pastikan diawali dengan `https://`.'
    );
  }

  return {
    type: 'search',
    query: input
  };
}

/**
 * Membungkus objek Track Lavalink dengan metadata requester & sumber asli.
 */
function normalizeTrack(rawTrack, requester, overrides = {}) {
  const info = rawTrack.info || {};
  return {
    encoded: rawTrack.encoded || null,
    info: {
      identifier: info.identifier || '',
      isSeekable: info.isSeekable !== undefined ? Boolean(info.isSeekable) : true,
      author: overrides.author || info.author || 'Artis Tidak Diketahui',
      length: Number(overrides.length ?? info.length ?? 0),
      isStream: Boolean(info.isStream),
      position: Number(info.position || 0),
      title: overrides.title || info.title || 'Tanpa Judul',
      uri: overrides.uri || info.uri || '',
      artworkUrl: overrides.artworkUrl || info.artworkUrl || null,
      isrc: info.isrc || null,
      sourceName: info.sourceName || 'unknown'
    },
    requester: requester
      ? {
          id: requester.id,
          tag: requester.tag || requester.username || 'Pengguna'
        }
      : null,
    originalSource: overrides.originalSource || info.sourceName || 'unknown',
    matchedVia: overrides.matchedVia || null,
    unresolved: Boolean(overrides.unresolved),
    searchQuery: overrides.searchQuery || null
  };
}

class SourceResolver {
  constructor(audioDiagnostics = null) {
    this.audioDiagnostics = audioDiagnostics;
    this.spotifyToken = null;
    this.spotifyTokenExpiresAt = 0;
  }

  /**
   * Mendapatkan Access Token Spotify Web API menggunakan alur resmi Client Credentials.
   */
  async getSpotifyAccessToken() {
    const clientId = config.spotify.clientId;
    const clientSecret = config.spotify.clientSecret;
    if (!clientId || !clientSecret) return null;

    if (this.spotifyToken && Date.now() < this.spotifyTokenExpiresAt - 30000) {
      return this.spotifyToken;
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      logger.warn(`Gagal mengambil token Spotify API (HTTP ${response.status})`);
      return null;
    }

    const data = await response.json();
    this.spotifyToken = data.access_token;
    this.spotifyTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    return this.spotifyToken;
  }

  /**
   * Membaca metadata Spotify menggunakan Spotify Web API resmi.
   */
  async fetchSpotifyViaApi(spotifyType, spotifyId, token) {
    const headers = { Authorization: `Bearer ${token}` };
    const maxItems = config.music.maxPlaylistTracks;

    if (spotifyType === 'track') {
      const res = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(spotifyId)}`, {
        headers,
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) return null;
      const t = await res.json();
      return {
        kind: 'track',
        items: [
          {
            title: t.name,
            author: (t.artists || []).map((a) => a.name).join(', ') || 'Spotify Artist',
            length: Number(t.duration_ms || 0),
            artworkUrl: t.album?.images?.[0]?.url || null,
            uri: t.external_urls?.spotify || `https://open.spotify.com/track/${spotifyId}`
          }
        ]
      };
    }

    if (spotifyType === 'album') {
      const res = await fetch(`https://api.spotify.com/v1/albums/${encodeURIComponent(spotifyId)}`, {
        headers,
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) return null;
      const album = await res.json();
      const artwork = album.images?.[0]?.url || null;
      const rawItems = album.tracks?.items || [];
      const items = rawItems.slice(0, maxItems).map((t) => ({
        title: t.name,
        author: (t.artists || []).map((a) => a.name).join(', ') || album.artists?.[0]?.name || 'Artis',
        length: Number(t.duration_ms || 0),
        artworkUrl: artwork,
        uri: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`
      }));
      return {
        kind: 'playlist',
        playlistName: `${album.name} — ${(album.artists || []).map((a) => a.name).join(', ')}`,
        items
      };
    }

    if (spotifyType === 'playlist') {
      const res = await fetch(
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(spotifyId)}?fields=name,images,tracks.items(track(id,name,duration_ms,external_urls,artists(name),album(images))),tracks.next`,
        { headers, signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) return null;
      const pl = await res.json();
      const fallbackArt = pl.images?.[0]?.url || null;
      const items = [];
      let pageItems = pl.tracks?.items || [];
      let nextUrl = pl.tracks?.next || null;

      while (pageItems.length > 0 && items.length < maxItems) {
        for (const entry of pageItems) {
          if (items.length >= maxItems) break;
          const t = entry?.track;
          if (!t || !t.name) continue;
          items.push({
            title: t.name,
            author: (t.artists || []).map((a) => a.name).join(', ') || 'Artis',
            length: Number(t.duration_ms || 0),
            artworkUrl: t.album?.images?.[0]?.url || fallbackArt,
            uri: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : '')
          });
        }
        if (!nextUrl || items.length >= maxItems) break;
        const nextRes = await fetch(nextUrl, { headers, signal: AbortSignal.timeout(10000) });
        if (!nextRes.ok) break;
        const nextJson = await nextRes.json();
        pageItems = nextJson.items || [];
        nextUrl = nextJson.next || null;
      }

      return {
        kind: 'playlist',
        playlistName: pl.name || 'Spotify Playlist',
        items
      };
    }

    if (spotifyType === 'artist') {
      const res = await fetch(
        `https://api.spotify.com/v1/artists/${encodeURIComponent(spotifyId)}/top-tracks?market=ID`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const items = (data.tracks || []).slice(0, maxItems).map((t) => ({
        title: t.name,
        author: (t.artists || []).map((a) => a.name).join(', ') || 'Artis',
        length: Number(t.duration_ms || 0),
        artworkUrl: t.album?.images?.[0]?.url || null,
        uri: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`
      }));
      return {
        kind: 'playlist',
        playlistName: `Top Lagu Spotify: ${items[0]?.author || 'Artis'}`,
        items
      };
    }

    return null;
  }

  /**
   * Fallback pembacaan metadata publik melalui halaman Embed / oEmbed resmi Spotify
   * saat kredensial API Spotify tidak diisi di .env.
   */
  async fetchSpotifyPublicMetadata(spotifyType, spotifyId, originalUrl) {
    try {
      const embedUrl = `https://open.spotify.com/embed/${encodeURIComponent(spotifyType)}/${encodeURIComponent(spotifyId)}`;
      const res = await fetch(embedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LaguKanBot/1.0)'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (res.ok) {
        const html = await res.text();
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (nextDataMatch && nextDataMatch[1]) {
          const parsed = JSON.parse(nextDataMatch[1]);
          const entity = parsed?.props?.pageProps?.state?.data?.entity;
          if (entity) {
            const coverArt =
              entity.visualIdentity?.image?.[0]?.url ||
              entity.coverArt?.sources?.[0]?.url ||
              null;

            if (spotifyType === 'track') {
              const artists = Array.isArray(entity.artists)
                ? entity.artists.map((a) => a.name).join(', ')
                : entity.subtitle || 'Artis Spotify';
              return {
                kind: 'track',
                items: [
                  {
                    title: entity.title || entity.name,
                    author: artists,
                    length: Number(entity.duration || 0),
                    artworkUrl: coverArt,
                    uri: `https://open.spotify.com/track/${spotifyId}`
                  }
                ]
              };
            }

            if (Array.isArray(entity.trackList) && entity.trackList.length > 0) {
              const items = entity.trackList
                .slice(0, config.music.maxPlaylistTracks)
                .map((item) => {
                  const trackIdMatch = String(item.uri || '').match(/spotify:track:([A-Za-z0-9]+)/);
                  return {
                    title: item.title,
                    author: item.subtitle || 'Artis Spotify',
                    length: Number(item.duration || 0),
                    artworkUrl: coverArt,
                    uri: trackIdMatch
                      ? `https://open.spotify.com/track/${trackIdMatch[1]}`
                      : originalUrl
                  };
                })
                .filter((i) => Boolean(i.title));

              if (items.length > 0) {
                return {
                  kind: 'playlist',
                  playlistName: entity.name || entity.title || 'Daftar Putar Spotify',
                  items
                };
              }
            }
          }
        }
      }
    } catch (err) {
      logger.debug('Fallback Spotify Embed gagal, mencoba oEmbed publik', err.message);
    }

    // Fallback oEmbed resmi untuk single track
    if (spotifyType === 'track') {
      try {
        const oembedRes = await fetch(
          `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${spotifyId}`)}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          if (oembed?.title) {
            return {
              kind: 'track',
              items: [
                {
                  title: oembed.title,
                  author: oembed.author_name || '',
                  length: 0,
                  artworkUrl: oembed.thumbnail_url || null,
                  uri: `https://open.spotify.com/track/${spotifyId}`
                }
              ]
            };
          }
        }
      } catch (err) {
        logger.debug('Fallback Spotify oEmbed juga gagal', err.message);
      }
    }

    return null;
  }

  /**
   * Menentukan urutan prioritas sumber pencarian berdasarkan kesehatan real-time node YouTube.
   * Jika YouTube sedang terkena blokir bot/login/403 (isYoutubeDegraded), otomatis utamakan
   * SoundCloud (scsearch) & Bandcamp (bcsearch) agar pengguna langsung mendapat stream yang dapat diputar!
   */
  getSearchPrefixOrder(node, preferredPrefix = config.music.defaultSearchSource, isExplicit = false) {
    if (isExplicit && preferredPrefix) {
      return [preferredPrefix, 'scsearch', 'bcsearch', 'ytmsearch', 'ytsearch'].filter(
        (v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx
      );
    }

    const ytDegraded = Boolean(this.audioDiagnostics?.isYoutubeDegraded?.(node?.name));
    if (ytDegraded) {
      return ['scsearch', 'bcsearch', 'ytmsearch', 'ytsearch'].filter(
        (v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx
      );
    }

    return [preferredPrefix, 'ytmsearch', 'scsearch', 'bcsearch', 'ytsearch'].filter(
      (v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx
    );
  }

  /**
   * Mencocokkan metadata lagu (judul + artis + durasi) ke sumber audio Lavalink
   * (otomatis beralih ke SoundCloud & Bandcamp jika YouTube terdegradasi).
   */
  async matchMetadataToAudio(node, meta, requester) {
    const cleanQuery = `${meta.title || ''} ${meta.author || ''}`.trim();
    const prefixes = this.getSearchPrefixOrder(node, config.music.defaultSearchSource, false);

    for (const prefix of prefixes) {
      try {
        const res = await node.rest.resolve(`${prefix}:${cleanQuery}`);
        if (res && res.loadType === LoadType.SEARCH && Array.isArray(res.data) && res.data.length > 0) {
          // Pilih kandidat dengan durasi paling mendekati jika metadata memiliki durasi
          let best = res.data[0];
          if (meta.length > 0) {
            let bestDiff = Infinity;
            for (const candidate of res.data.slice(0, 5)) {
              const diff = Math.abs(Number(candidate.info?.length || 0) - meta.length);
              if (diff < bestDiff) {
                bestDiff = diff;
                best = candidate;
              }
            }
          }

          return normalizeTrack(best, requester, {
            title: meta.title || best.info?.title,
            author: meta.author || best.info?.author,
            artworkUrl: meta.artworkUrl || best.info?.artworkUrl,
            uri: meta.uri || best.info?.uri,
            originalSource: 'spotify-matched',
            matchedVia: best.info?.sourceName || prefix.replace('search', ''),
            unresolved: false
          });
        }
      } catch (err) {
        logger.debug(`Pencocokan audio dengan ${prefix} gagal untuk "${cleanQuery}": ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Menyelesaikan lagu deferred (misal lagu ke-2..N dari album/playlist Spotify atau saved playlist tanpa encoded).
   */
  async ensureTrackResolved(node, track) {
    if (!track) return null;
    if (track.encoded && !track.unresolved) {
      return track;
    }

    if (!node) {
      throw new AppError(
        ErrorCodes.LAVALINK_OFFLINE,
        'Node Lavalink sedang tidak tersedia untuk memproses lagu.'
      );
    }

    // Jika memiliki URL langsung non-Spotify (misal YouTube / SoundCloud dari Saved Playlist), coba resolve URL dulu
    const uri = track.info?.uri || '';
    if (uri && /^https?:\/\//i.test(uri) && !SPOTIFY_URL_REGEX.test(uri)) {
      try {
        const directRes = await node.rest.resolve(uri);
        if (directRes?.loadType === LoadType.TRACK && directRes.data?.encoded) {
          return normalizeTrack(directRes.data, track.requester, {
            originalSource: track.originalSource || directRes.data.info?.sourceName
          });
        }
      } catch {
        // Lanjut ke pencarian teks di bawah
      }
    }

    const queryText =
      track.searchQuery ||
      `${track.info?.title || ''} ${track.info?.author || ''}`.trim();

    const matched = await this.matchMetadataToAudio(
      node,
      {
        title: track.info?.title,
        author: track.info?.author,
        length: track.info?.length,
        artworkUrl: track.info?.artworkUrl,
        uri: track.info?.uri
      },
      track.requester
    );

    if (matched) {
      if (track.originalSource && track.originalSource !== 'spotify-matched') {
        matched.originalSource = track.originalSource;
      }
      return matched;
    }

    // Fallback terakhir via default search
    const fallbackRes = await this.searchTracks(node, queryText, config.music.defaultSearchSource, 1, track.requester);
    if (fallbackRes.length > 0) {
      return fallbackRes[0];
    }

    throw new AppError(
      ErrorCodes.TRACK_NOT_FOUND,
      `Tidak dapat menemukan sumber audio yang cocok untuk **${track.info?.title || queryText}**.`
    );
  }

  /**
   * Menangani URL Spotify (plugin LavaSrc jika ada, atau ekstraksi metadata + pencocokan audio).
   */
  async resolveSpotify(node, classified, requester) {
    // 1. Coba melalui Lavalink terlebih dahulu apabila server memasang plugin LavaSrc
    try {
      const nativeRes = await node.rest.resolve(classified.url);
      if (nativeRes?.loadType === LoadType.TRACK && nativeRes.data) {
        return {
          kind: 'track',
          tracks: [
            normalizeTrack(nativeRes.data, requester, { originalSource: 'spotify' })
          ]
        };
      }
      if (nativeRes?.loadType === LoadType.PLAYLIST && nativeRes.data?.tracks?.length) {
        const tracks = nativeRes.data.tracks
          .slice(0, config.music.maxPlaylistTracks)
          .map((t) => normalizeTrack(t, requester, { originalSource: 'spotify' }));
        return {
          kind: 'playlist',
          playlistInfo: {
            name: nativeRes.data.info?.name || 'Spotify Playlist',
            source: 'spotify',
            note: 'Diproses melalui pencocokan metadata Spotify pada Lavalink.'
          },
          tracks
        };
      }
    } catch (err) {
      logger.debug(`Lavalink tidak memproses URL Spotify secara langsung, beralih ke resolver metadata: ${err.message}`);
    }

    // 2. Ambil metadata melalui Spotify Web API (jika dikonfigurasi) atau Spotify Embed/oEmbed publik
    let metadata = null;
    try {
      const token = await this.getSpotifyAccessToken();
      if (token) {
        metadata = await this.fetchSpotifyViaApi(classified.spotifyType, classified.spotifyId, token);
      }
    } catch (err) {
      logger.warn('Kendala saat mengakses Spotify Web API, menggunakan fallback publik', err.message);
    }

    if (!metadata) {
      metadata = await this.fetchSpotifyPublicMetadata(
        classified.spotifyType,
        classified.spotifyId,
        classified.url
      );
    }

    if (!metadata || !Array.isArray(metadata.items) || metadata.items.length === 0) {
      throw new AppError(
        ErrorCodes.TRACK_NOT_FOUND,
        'Gagal membaca metadata dari tautan Spotify tersebut. Pastikan tautan bersifat **Publik**, atau atur `SPOTIFY_CLIENT_ID` & `SPOTIFY_CLIENT_SECRET` pada `.env` untuk dukungan penuh playlist/album besar.'
      );
    }

    if (metadata.kind === 'track' || metadata.items.length === 1) {
      const matched = await this.matchMetadataToAudio(node, metadata.items[0], requester);
      if (!matched) {
        throw new AppError(
          ErrorCodes.TRACK_NOT_FOUND,
          `Metadata Spotify ditemukan (**${metadata.items[0].title}**), namun tidak ada sumber audio yang cocok pada Lavalink.`
        );
      }
      return {
        kind: 'track',
        tracks: [matched]
      };
    }

    // Untuk Album / Playlist Spotify: cocokkan lagu pertama segera agar musik langsung berputar,
    // dan siapkan lagu sisanya secara deferred (lazy audio matching) agar respons super cepat!
    const [firstMeta, ...restMeta] = metadata.items;
    const firstMatched = await this.matchMetadataToAudio(node, firstMeta, requester);

    const tracks = [];
    if (firstMatched) {
      tracks.push(firstMatched);
    }

    for (const item of restMeta) {
      tracks.push({
        encoded: null,
        info: {
          identifier: `spotify:${item.title}:${item.author}`,
          isSeekable: true,
          author: item.author || 'Artis Spotify',
          length: Number(item.length || 0),
          isStream: false,
          position: 0,
          title: item.title || 'Lagu Spotify',
          uri: item.uri || classified.url,
          artworkUrl: item.artworkUrl || null,
          isrc: null,
          sourceName: 'spotify-matched'
        },
        requester: requester
          ? { id: requester.id, tag: requester.tag || requester.username || 'Pengguna' }
          : null,
        originalSource: 'spotify-matched',
        matchedVia: null,
        unresolved: true,
        searchQuery: `${item.title} ${item.author}`.trim()
      });
    }

    if (tracks.length === 0) {
      throw new AppError(
        ErrorCodes.TRACK_NOT_FOUND,
        'Tidak ada lagu dari daftar Spotify tersebut yang dapat dicocokkan dengan sumber audio.'
      );
    }

    return {
      kind: 'playlist',
      playlistInfo: {
        name: metadata.playlistName || 'Daftar Putar Spotify',
        source: 'spotify-matched',
        note: 'Metadata dibaca dari Spotify dan dicocokkan otomatis dengan sumber audio yang tersedia (bukan streaming DRM langsung dari Spotify).'
      },
      tracks
    };
  }

  /**
   * Mencari daftar lagu berdasarkan kata kunci untuk /search maupun /play.
   * Mendukung fallback lintas sumber otomatis (YouTube Music -> YouTube -> SoundCloud)
   * serta memprioritaskan track non-livestream agar kompatibel dengan stream Opus.
   */
  async searchTracks(
    node,
    query,
    sourcePrefix = config.music.defaultSearchSource,
    limit = 10,
    requester = null,
    { explicitPrefix = false } = {}
  ) {
    if (!node) {
      throw new AppError(
        ErrorCodes.LAVALINK_OFFLINE,
        'Server audio Lavalink sedang offline. Tidak dapat melakukan pencarian lagu.'
      );
    }

    const fallbackOrder = this.getSearchPrefixOrder(node, sourcePrefix, explicitPrefix);

    for (const prefix of fallbackOrder) {
      try {
        const response = await node.rest.resolve(`${prefix}:${query}`);
        if (response?.loadType === LoadType.SEARCH && Array.isArray(response.data) && response.data.length > 0) {
          // Prioritaskan track vod/reguler dibanding livestream karena livestream YouTube selalu membutuhkan transcoding AAC
          const nonLive = response.data.filter((t) => !t?.info?.isStream);
          const ordered = nonLive.length > 0 ? [...nonLive, ...response.data.filter((t) => t?.info?.isStream)] : response.data;
          return ordered.slice(0, limit).map((t) => normalizeTrack(t, requester));
        }
        if (response?.loadType === LoadType.TRACK && response.data) {
          return [normalizeTrack(response.data, requester)];
        }
        if (response?.loadType === LoadType.ERROR && this.audioDiagnostics) {
          this.audioDiagnostics.recordTrackError({
            guildId: null,
            nodeName: node.name,
            track: { info: { title: query, sourceName: prefix } },
            stage: 'SEARCH_LOAD',
            rawException: response.data
          });
        }
      } catch (err) {
        logger.warn(`Pencarian dengan prefix "${prefix}:" gagal untuk "${query}", mencoba sumber berikutnya: ${err.message}`);
        if (this.audioDiagnostics) {
          this.audioDiagnostics.recordTrackError({
            guildId: null,
            nodeName: node.name,
            track: { info: { title: query, sourceName: prefix } },
            stage: 'SEARCH_REST',
            rawException: err
          });
        }
      }
    }

    return [];
  }

  /**
   * Membersihkan judul & nama artis dari label video agar pencocokan lintas platform akurat.
   */
  buildCleanSearchQuery(trackInfo) {
    if (!trackInfo) return '';
    const rawTitle = String(trackInfo.title || '')
      .replace(/\(.*?\)|\[.*?\]/g, '')
      .replace(/official\s*(music\s*)?(video|audio|lyric[s]?|visualizer|mv)/gi, '')
      .replace(/\b(hd|hq|4k|remastered|lyrics?)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const rawAuthor = String(trackInfo.author || '')
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .replace(/Official$/i, '')
      .trim();

    if (rawAuthor && rawTitle.toLowerCase().includes(rawAuthor.toLowerCase())) {
      return rawTitle;
    }
    return `${rawTitle} ${rawAuthor}`.trim();
  }

  /**
   * Mencari stream cadangan di SoundCloud (Ogg Opus) apabila pemutaran YouTube gagal didekode/diblokir.
   */
  async findSoundCloudFallback(node, failedTrack) {
    if (!node || !failedTrack?.info) return null;
    const query = this.buildCleanSearchQuery(failedTrack.info);
    if (!query) return null;

    const triedIds = new Set(failedTrack._triedIdentifiers || []);
    if (failedTrack.info.identifier) triedIds.add(failedTrack.info.identifier);

    try {
      const res = await node.rest.resolve(`scsearch:${query}`);
      if (res?.loadType === LoadType.SEARCH && Array.isArray(res.data) && res.data.length > 0) {
        const candidates = res.data.filter(
          (c) =>
            c?.encoded &&
            !c?.info?.isStream &&
            !triedIds.has(c.info?.identifier) &&
            Number(c.info?.length || 0) >= 35000 // Lewati potongan preview 30 detik SoundCloud Go+
        );
        const pool = candidates.length > 0
          ? candidates
          : res.data.filter((c) => c?.encoded && !triedIds.has(c.info?.identifier));

        if (pool.length === 0) return null;

        const targetLen = Number(failedTrack.info.length || 0);
        let best = pool[0];
        if (targetLen > 0) {
          let bestDiff = Infinity;
          for (const candidate of pool.slice(0, 6)) {
            const diff = Math.abs(Number(candidate.info?.length || 0) - targetLen);
            if (diff < bestDiff) {
              bestDiff = diff;
              best = candidate;
            }
          }
        }

        const fallback = normalizeTrack(best, failedTrack.requester, {
          artworkUrl: best.info?.artworkUrl || failedTrack.info.artworkUrl || null,
          originalSource: 'soundcloud',
          matchedVia: 'soundcloud-fallback'
        });
        fallback._retriedViaSoundCloud = true;
        fallback._fallbackAttempts = Number(failedTrack._fallbackAttempts || 0) + 1;
        fallback._triedSources = [...new Set([...(failedTrack._triedSources || []), String(failedTrack.info.sourceName || 'youtube').toLowerCase(), 'soundcloud'])];
        fallback._triedIdentifiers = [...triedIds, best.info?.identifier].filter(Boolean);
        fallback.fallbackFrom = failedTrack.info.sourceName || failedTrack.originalSource || 'youtube';
        return fallback;
      }
    } catch (err) {
      logger.debug(`Fallback SoundCloud gagal untuk "${query}": ${err.message}`);
    }

    return null;
  }

  /**
   * Mencari stream cadangan di Bandcamp apabila YouTube & SoundCloud tidak tersedia.
   */
  async findBandcampFallback(node, failedTrack) {
    if (!node || !failedTrack?.info) return null;
    const query = this.buildCleanSearchQuery(failedTrack.info);
    if (!query) return null;

    const triedIds = new Set(failedTrack._triedIdentifiers || []);
    if (failedTrack.info.identifier) triedIds.add(failedTrack.info.identifier);

    try {
      const res = await node.rest.resolve(`bcsearch:${query}`);
      if (res?.loadType === LoadType.SEARCH && Array.isArray(res.data) && res.data.length > 0) {
        const candidates = res.data.filter(
          (c) => c?.encoded && !c?.info?.isStream && !triedIds.has(c.info?.identifier)
        );
        if (candidates.length === 0) return null;

        const targetLen = Number(failedTrack.info.length || 0);
        let best = candidates[0];
        if (targetLen > 0) {
          let bestDiff = Infinity;
          for (const candidate of candidates.slice(0, 6)) {
            const diff = Math.abs(Number(candidate.info?.length || 0) - targetLen);
            if (diff < bestDiff) {
              bestDiff = diff;
              best = candidate;
            }
          }
        }

        const fallback = normalizeTrack(best, failedTrack.requester, {
          artworkUrl: best.info?.artworkUrl || failedTrack.info.artworkUrl || null,
          originalSource: 'bandcamp',
          matchedVia: 'bandcamp-fallback'
        });
        fallback._retriedViaBandcamp = true;
        fallback._fallbackAttempts = Number(failedTrack._fallbackAttempts || 0) + 1;
        fallback._triedSources = [
          ...new Set([
            ...(failedTrack._triedSources || []),
            String(failedTrack.info.sourceName || 'youtube').toLowerCase(),
            'bandcamp'
          ])
        ];
        fallback._triedIdentifiers = [...triedIds, best.info?.identifier].filter(Boolean);
        fallback.fallbackFrom = failedTrack.info.sourceName || failedTrack.originalSource || 'youtube';
        return fallback;
      }
    } catch (err) {
      logger.debug(`Fallback Bandcamp gagal untuk "${query}": ${err.message}`);
    }

    return null;
  }

  /**
   * Rantai fallback multi-source terbatas (bounded) saat track gagal dimuat/didekode saat playback:
   * 1. Prioritas 1: SoundCloud (scsearch — Ogg Opus murni, bebas login/403 YouTube & bebas AacDecoderLibrary).
   * 2. Prioritas 2: Bandcamp (bcsearch — stream musik independen legal tanpa blokir YouTube).
   * 3. Prioritas 3: Kandidat non-livestream alternatif hanya jika YouTube TIDAK sedang terdegradasi.
   * Maksimal percobaan dibatasi ketat oleh config.music.maxFallbackAttempts (default 2) agar tidak pernah loop tak terbatas.
   */
  async findFallbackTrack(node, failedTrack) {
    if (!node || !failedTrack?.info) return null;

    const attemptsSoFar = Number(failedTrack._fallbackAttempts || 0);
    if (attemptsSoFar >= config.music.maxFallbackAttempts) {
      return null;
    }

    const srcName = String(failedTrack.info.sourceName || failedTrack.originalSource || '').toLowerCase();
    const triedSources = new Set(failedTrack._triedSources || []);
    if (srcName) triedSources.add(srcName);

    const triedIds = new Set(failedTrack._triedIdentifiers || []);
    if (failedTrack.info.identifier) triedIds.add(failedTrack.info.identifier);

    // Prioritas 1: SoundCloud Ogg Opus (sangat andal di Android Termux ARM64 karena Pure-Java Opus Passthrough)
    if (!triedSources.has('soundcloud') && !failedTrack._retriedViaSoundCloud) {
      const scFallback = await this.findSoundCloudFallback(node, failedTrack);
      if (scFallback?.encoded) {
        return scFallback;
      }
      triedSources.add('soundcloud');
    }

    // Prioritas 2: Bandcamp (bcsearch — didukung bawaan oleh Lavalink v4 ketika bandcamp: true)
    if (!triedSources.has('bandcamp') && !failedTrack._retriedViaBandcamp) {
      const bcFallback = await this.findBandcampFallback(node, failedTrack);
      if (bcFallback?.encoded) {
        return bcFallback;
      }
      triedSources.add('bandcamp');
    }

    // Prioritas 3: Kandidat alternatif YouTube HANYA apabila node YouTube tidak sedang terdegradasi (403/login/AllClientsFailed)
    if (this.audioDiagnostics?.isYoutubeDegraded?.(node.name)) {
      return null;
    }

    const query = this.buildCleanSearchQuery(failedTrack.info);
    if (!query) return null;

    const altPrefixes = ['ytmsearch', 'ytsearch'];
    for (const prefix of altPrefixes) {
      try {
        const res = await node.rest.resolve(`${prefix}:${query}`);
        if (res?.loadType === LoadType.SEARCH && Array.isArray(res.data) && res.data.length > 0) {
          const alt = res.data.find(
            (c) =>
              c?.encoded &&
              !c?.info?.isStream &&
              c.info?.identifier &&
              !triedIds.has(c.info.identifier)
          );
          if (alt) {
            const normalized = normalizeTrack(alt, failedTrack.requester, {
              artworkUrl: alt.info?.artworkUrl || failedTrack.info.artworkUrl || null,
              matchedVia: `${prefix.replace('search', '')}-fallback`
            });
            normalized._fallbackAttempts = attemptsSoFar + 1;
            normalized._triedSources = [...triedSources, String(alt.info?.sourceName || prefix).toLowerCase()];
            normalized._triedIdentifiers = [...triedIds, alt.info.identifier];
            normalized.fallbackFrom = srcName || 'unknown';
            return normalized;
          }
        }
      } catch (err) {
        logger.debug(`Fallback ${prefix} gagal untuk "${query}": ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Titik masuk utama pemrosesan input lagu/URL multi-source.
   */
  async resolve(node, rawQuery, requester, options = {}) {
    const guildId = options.guildId || null;

    if (!node) {
      throw new AppError(
        ErrorCodes.LAVALINK_OFFLINE,
        'Server audio Lavalink sedang tidak terhubung. Pastikan proses Lavalink aktif terlebih dahulu.'
      );
    }

    const classified = classifyInput(rawQuery);
    if (this.audioDiagnostics && guildId) {
      this.audioDiagnostics.recordStage(
        guildId,
        2,
        'Klasifikasi & Pencarian Sumber',
        `tipe=${classified.type}, input="${String(rawQuery).slice(0, 80)}"`
      );
    }

    if (classified.type === 'spotify') {
      const spResult = await this.resolveSpotify(node, classified, requester);
      if (this.audioDiagnostics && guildId) {
        this.audioDiagnostics.recordStage(
          guildId,
          3,
          'Track Spotify Berhasil Dicocokkan',
          `jenis=${spResult.kind}, jumlah=${spResult.tracks.length}`
        );
      }
      return spResult;
    }

    if (classified.type === 'search') {
      const results = await this.searchTracks(
        node,
        classified.query,
        classified.explicitPrefix || config.music.defaultSearchSource,
        5,
        requester,
        { explicitPrefix: Boolean(classified.explicitPrefix) }
      );
      if (results.length === 0) {
        throw new AppError(
          ErrorCodes.TRACK_NOT_FOUND,
          `Tidak ditemukan hasil lagu untuk kata kunci **"${classified.query}"**.`
        );
      }
      if (this.audioDiagnostics && guildId) {
        this.audioDiagnostics.recordStage(
          guildId,
          3,
          'Track Pencarian Dimuat Lavalink',
          `judul="${results[0].info.title}" [${results[0].info.sourceName}]`
        );
      }
      return {
        kind: 'track',
        tracks: [results[0]]
      };
    }

    // URL langsung: YouTube, YouTube Music, SoundCloud, Direct Audio, atau Generic URL
    let response;
    try {
      response = await node.rest.resolve(classified.url);
    } catch (err) {
      logger.error(`Kegagalan REST Lavalink saat memproses URL ${classified.url}`, err);
      if (this.audioDiagnostics) {
        this.audioDiagnostics.recordTrackError({
          guildId,
          nodeName: node.name,
          track: { info: { title: classified.url, sourceName: classified.type } },
          stage: 'URL_REST',
          rawException: err
        });
      }
      throw err;
    }

    // Jika URL YouTube/YT Music gagal dimuat langsung di sisi Lavalink (ERROR/EMPTY),
    // coba ambil judul via oEmbed publik YouTube lalu cari stream cadangan di SoundCloud!
    if (
      (!response || response.loadType === LoadType.ERROR || response.loadType === LoadType.EMPTY) &&
      (classified.type === 'youtube' || classified.type === 'youtube_music')
    ) {
      if (response?.loadType === LoadType.ERROR && this.audioDiagnostics) {
        this.audioDiagnostics.recordTrackError({
          guildId,
          nodeName: node.name,
          track: { info: { title: classified.url, sourceName: classified.type } },
          stage: 'URL_LOAD',
          rawException: response.data
        });
      }

      const ytFallback = await this.tryResolveYoutubeUrlViaFallback(node, classified.url, requester);
      if (ytFallback) {
        if (this.audioDiagnostics && guildId) {
          this.audioDiagnostics.recordStage(
            guildId,
            3,
            'URL YouTube Dialihkan ke Sumber Fallback',
            `judul="${ytFallback.info.title}" [${ytFallback.info.sourceName}]`
          );
        }
        return {
          kind: 'track',
          tracks: [ytFallback]
        };
      }
    }

    if (!response || response.loadType === LoadType.EMPTY) {
      if (classified.type === 'generic_url') {
        throw new AppError(
          ErrorCodes.UNSUPPORTED_SOURCE,
          `Sumber URL **${classified.host}** tidak didukung atau tidak memuat stream audio yang valid.`
        );
      }
      throw new AppError(
        ErrorCodes.TRACK_NOT_FOUND,
        'Lagu atau daftar putar tidak ditemukan dari URL tersebut (mungkin bersifat privat atau telah dihapus).'
      );
    }

    if (response.loadType === LoadType.ERROR) {
      let diagnosis = null;
      if (this.audioDiagnostics) {
        diagnosis = this.audioDiagnostics.recordTrackError({
          guildId,
          nodeName: node.name,
          track: { info: { title: classified.url, sourceName: classified.type } },
          stage: 'URL_LOAD',
          rawException: response.data
        });
      }
      const causeMsg = diagnosis?.userMessage || response.data?.message || 'Tidak dapat memuat sumber audio.';
      if (classified.type === 'generic_url') {
        throw new AppError(
          ErrorCodes.UNSUPPORTED_SOURCE,
          `Sumber audio tidak didukung oleh Lavalink: ${causeMsg}`
        );
      }
      throw new AppError(
        ErrorCodes.TRACK_PLAYBACK_FAILED,
        `Gagal memuat media dari sumber tersebut: ${causeMsg}`
      );
    }

    const sourceOverride = classified.type === 'youtube_music' ? 'youtubemusic' : undefined;

    if (response.loadType === LoadType.TRACK && response.data) {
      const normalized = normalizeTrack(response.data, requester, {
        originalSource: sourceOverride || response.data.info?.sourceName
      });
      if (classified.type === 'direct_audio') {
        normalized.directStreamUrl = classified.url;
      }
      if (this.audioDiagnostics && guildId) {
        this.audioDiagnostics.recordStage(
          guildId,
          3,
          'Track URL Dimuat Lavalink',
          `judul="${normalized.info.title}" [${normalized.info.sourceName}]`
        );
      }
      return {
        kind: 'track',
        tracks: [normalized]
      };
    }

    if (response.loadType === LoadType.PLAYLIST && response.data?.tracks?.length) {
      const tracks = response.data.tracks
        .slice(0, config.music.maxPlaylistTracks)
        .map((t) =>
          normalizeTrack(t, requester, {
            originalSource: sourceOverride || t.info?.sourceName
          })
        );
      if (this.audioDiagnostics && guildId) {
        this.audioDiagnostics.recordStage(
          guildId,
          3,
          'Playlist URL Dimuat Lavalink',
          `nama="${response.data.info?.name || 'Playlist'}", jumlah=${tracks.length}`
        );
      }
      return {
        kind: 'playlist',
        playlistInfo: {
          name: response.data.info?.name || 'Daftar Putar',
          source: sourceOverride || tracks[0]?.info?.sourceName || 'playlist'
        },
        tracks
      };
    }

    if (response.loadType === LoadType.SEARCH && Array.isArray(response.data) && response.data.length > 0) {
      const normalized = normalizeTrack(response.data[0], requester, {
        originalSource: sourceOverride || response.data[0].info?.sourceName
      });
      if (this.audioDiagnostics && guildId) {
        this.audioDiagnostics.recordStage(
          guildId,
          3,
          'Track Hasil URL Dimuat Lavalink',
          `judul="${normalized.info.title}" [${normalized.info.sourceName}]`
        );
      }
      return {
        kind: 'track',
        tracks: [normalized]
      };
    }

    throw new AppError(
      ErrorCodes.TRACK_NOT_FOUND,
      'Tidak ditemukan media audio yang dapat diputar dari tautan tersebut.'
    );
  }

  /**
   * Jika URL YouTube spesifik gagal dimuat langsung oleh Lavalink, ambil metadata judul/artis
   * dari endpoint resmi YouTube oEmbed lalu cocokkan ke SoundCloud agar lagu tetap dapat diputar.
   */
  async tryResolveYoutubeUrlViaFallback(node, youtubeUrl, requester) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`;
      const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const meta = await res.json();
      if (!meta?.title) return null;

      const syntheticFailed = {
        info: {
          title: meta.title,
          author: meta.author_name || '',
          length: 0,
          artworkUrl: meta.thumbnail_url || null,
          sourceName: 'youtube'
        },
        requester
      };

      const scMatch = await this.findSoundCloudFallback(node, syntheticFailed);
      if (scMatch) return scMatch;
      return await this.findBandcampFallback(node, syntheticFailed);
    } catch {
      return null;
    }
  }
}

module.exports = {
  SourceResolver,
  classifyInput,
  normalizeTrack,
  isPrivateOrLocalHost
};
