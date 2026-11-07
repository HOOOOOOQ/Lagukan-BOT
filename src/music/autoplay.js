'use strict';

const { LoadType } = require('shoukaku');
const { normalizeTrack } = require('./sourceResolver');
const logger = require('../utils/logger').child('Autoplay');

function sanitizeTitleForMatch(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/official\s*(music\s*)?(video|audio|lyric[s]?|visualizer)/gi, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeArtist(author) {
  return String(author || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();
}

/**
 * Mencari lagu rekomendasi berikutnya secara otomatis ketika antrean habis dan Autoplay aktif.
 */
async function findAutoplayTrack(node, lastTrack, history = []) {
  if (!node || !lastTrack?.info) return null;

  const seenIdentifiers = new Set();
  const seenTitles = new Set();

  const registerSeen = (track) => {
    if (!track?.info) return;
    if (track.info.identifier) seenIdentifiers.add(track.info.identifier);
    const norm = sanitizeTitleForMatch(track.info.title);
    if (norm) seenTitles.add(norm);
  };

  registerSeen(lastTrack);
  for (const h of history) {
    registerSeen(h);
  }

  const artist = sanitizeArtist(lastTrack.info.author);
  const cleanTitle = sanitizeTitleForMatch(lastTrack.info.title);

  const queries = [];
  if (artist && artist.toLowerCase() !== 'artis tidak diketahui') {
    queries.push(`ytmsearch:${artist} ${cleanTitle}`);
    queries.push(`ytmsearch:${artist}`);
    queries.push(`ytsearch:${artist} official audio`);
    queries.push(`scsearch:${artist}`);
  } else if (cleanTitle) {
    queries.push(`ytmsearch:${cleanTitle}`);
    queries.push(`ytsearch:${cleanTitle}`);
  }

  for (const searchQuery of queries) {
    try {
      const res = await node.rest.resolve(searchQuery);
      if (res?.loadType === LoadType.SEARCH && Array.isArray(res.data)) {
        for (const candidate of res.data) {
          const info = candidate.info;
          if (!info || info.isStream) continue;

          // Hindari klip terlalu pendek (<45 detik) atau kompilasi panjang (>15 menit)
          if (info.length > 0 && (info.length < 45000 || info.length > 900000)) {
            continue;
          }

          if (seenIdentifiers.has(info.identifier)) continue;
          const candidateNorm = sanitizeTitleForMatch(info.title);
          if (candidateNorm && seenTitles.has(candidateNorm)) continue;

          return normalizeTrack(candidate, {
            id: null,
            tag: 'Autoplay ✨'
          });
        }
      }
    } catch (err) {
      logger.debug(`Pencarian autoplay gagal untuk "${searchQuery}": ${err.message}`);
    }
  }

  return null;
}

module.exports = {
  findAutoplayTrack,
  sanitizeTitleForMatch,
  sanitizeArtist
};
