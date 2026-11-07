'use strict';

const { config } = require('../../config/config');
const { AppError, ErrorCodes } = require('../utils/errorHandler');

class PlaylistRepository {
  constructor(db) {
    this.db = db;
  }

  normalizeName(name) {
    const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
    if (cleaned.length < 2 || cleaned.length > 50) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Nama playlist harus memiliki panjang antara **2 hingga 50 karakter**.',
        { isWarning: true }
      );
    }
    return cleaned;
  }

  savePlaylist({ name, ownerId, ownerTag, guildId = null, isPublic = false, tracks = [] }) {
    const cleanName = this.normalizeName(name);
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new AppError(
        ErrorCodes.EMPTY_QUEUE,
        'Tidak ada lagu untuk disimpan ke dalam playlist.',
        { isWarning: true }
      );
    }

    const cappedTracks = tracks.slice(0, config.music.maxPlaylistTracks);
    const now = Date.now();

    return this.db.transaction(() => {
      const existing = this.db.get(
        'SELECT id, created_at FROM playlists WHERE owner_id = ? AND name = ? COLLATE NOCASE;',
        [String(ownerId), cleanName]
      );

      let playlistId;
      if (existing) {
        playlistId = existing.id;
        this.db.run(
          `UPDATE playlists
           SET name = ?, owner_tag = ?, guild_id = ?, is_public = ?, updated_at = ?
           WHERE id = ?;`,
          [
            cleanName,
            String(ownerTag || 'Pengguna'),
            guildId ? String(guildId) : null,
            isPublic ? 1 : 0,
            now,
            playlistId
          ]
        );
        this.db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?;', [playlistId]);
      } else {
        this.db.run(
          `INSERT INTO playlists (name, owner_id, owner_tag, guild_id, is_public, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [
            cleanName,
            String(ownerId),
            String(ownerTag || 'Pengguna'),
            guildId ? String(guildId) : null,
            isPublic ? 1 : 0,
            now,
            now
          ]
        );
        const inserted = this.db.get(
          'SELECT id FROM playlists WHERE owner_id = ? AND name = ? COLLATE NOCASE;',
          [String(ownerId), cleanName]
        );
        playlistId = inserted.id;
      }

      cappedTracks.forEach((track, idx) => {
        const info = track.info || track;
        this.db.run(
          `INSERT INTO playlist_tracks (
            playlist_id, position, title, author, uri, identifier,
            encoded, duration, artwork_url, source_name
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            playlistId,
            idx + 1,
            String(info.title || 'Tanpa Judul'),
            String(info.author || 'Artis Tidak Diketahui'),
            info.uri ? String(info.uri) : null,
            info.identifier ? String(info.identifier) : null,
            track.encoded ? String(track.encoded) : null,
            Number(info.length ?? info.duration ?? 0) || 0,
            info.artworkUrl || info.artwork_url || null,
            String(track.originalSource || info.sourceName || info.source_name || 'unknown')
          ]
        );
      });

      return {
        id: playlistId,
        name: cleanName,
        trackCount: cappedTracks.length,
        overwritten: Boolean(existing),
        isPublic: Boolean(isPublic)
      };
    });
  }

  findAccessiblePlaylist(userId, guildId, name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return null;

    // Utamakan playlist milik pengguna sendiri
    const own = this.db.get(
      'SELECT * FROM playlists WHERE owner_id = ? AND name = ? COLLATE NOCASE;',
      [String(userId), cleanName]
    );
    if (own) return own;

    // Jika tidak ditemukan, cari playlist publik pada server yang sama
    if (guildId) {
      return this.db.get(
        'SELECT * FROM playlists WHERE guild_id = ? AND is_public = 1 AND name = ? COLLATE NOCASE LIMIT 1;',
        [String(guildId), cleanName]
      );
    }

    return null;
  }

  findOwnedPlaylist(userId, name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return null;
    return this.db.get(
      'SELECT * FROM playlists WHERE owner_id = ? AND name = ? COLLATE NOCASE;',
      [String(userId), cleanName]
    );
  }

  listAccessiblePlaylists(userId, guildId = null) {
    const rows = this.db.all(
      `SELECT p.*,
              COUNT(pt.id) AS track_count,
              COALESCE(SUM(pt.duration), 0) AS total_duration
       FROM playlists p
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       WHERE p.owner_id = ? OR (p.guild_id = ? AND p.is_public = 1)
       GROUP BY p.id
       ORDER BY p.updated_at DESC;`,
      [String(userId), guildId ? String(guildId) : '']
    );
    return rows;
  }

  getTracks(playlistId) {
    return this.db.all(
      'SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC;',
      [Number(playlistId)]
    );
  }

  addTrack(userId, playlistName, track, ownerTag = 'Pengguna', guildId = null) {
    const cleanName = this.normalizeName(playlistName);
    const info = track.info || track;
    const now = Date.now();

    return this.db.transaction(() => {
      let playlist = this.findOwnedPlaylist(userId, cleanName);
      if (!playlist) {
        this.db.run(
          `INSERT INTO playlists (name, owner_id, owner_tag, guild_id, is_public, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?);`,
          [cleanName, String(userId), String(ownerTag), guildId ? String(guildId) : null, now, now]
        );
        playlist = this.findOwnedPlaylist(userId, cleanName);
      }

      const countRow = this.db.get(
        'SELECT COUNT(*) AS count FROM playlist_tracks WHERE playlist_id = ?;',
        [playlist.id]
      );
      const currentCount = Number(countRow?.count || 0);
      if (currentCount >= config.music.maxPlaylistTracks) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Playlist **${playlist.name}** sudah mencapai batas maksimum (${config.music.maxPlaylistTracks} lagu).`,
          { isWarning: true }
        );
      }

      const nextPosition = currentCount + 1;
      this.db.run(
        `INSERT INTO playlist_tracks (
          playlist_id, position, title, author, uri, identifier,
          encoded, duration, artwork_url, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          playlist.id,
          nextPosition,
          String(info.title || 'Tanpa Judul'),
          String(info.author || 'Artis Tidak Diketahui'),
          info.uri ? String(info.uri) : null,
          info.identifier ? String(info.identifier) : null,
          track.encoded ? String(track.encoded) : null,
          Number(info.length ?? info.duration ?? 0) || 0,
          info.artworkUrl || info.artwork_url || null,
          String(track.originalSource || info.sourceName || 'unknown')
        ]
      );

      this.db.run('UPDATE playlists SET updated_at = ? WHERE id = ?;', [now, playlist.id]);

      return {
        playlist,
        position: nextPosition
      };
    });
  }

  removeTrack(userId, playlistName, position1Based) {
    const playlist = this.findOwnedPlaylist(userId, playlistName);
    if (!playlist) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Playlist pribadi bernama **${playlistName}** tidak ditemukan.`,
        { isWarning: true }
      );
    }

    const tracks = this.getTracks(playlist.id);
    const index = Number(position1Based) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= tracks.length) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Nomor lagu tidak valid. Playlist **${playlist.name}** memiliki **${tracks.length}** lagu.`,
        { isWarning: true }
      );
    }

    const target = tracks[index];

    this.db.transaction(() => {
      this.db.run('DELETE FROM playlist_tracks WHERE id = ?;', [target.id]);
      const remaining = this.db.all(
        'SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC;',
        [playlist.id]
      );
      remaining.forEach((row, idx) => {
        this.db.run('UPDATE playlist_tracks SET position = ? WHERE id = ?;', [idx + 1, row.id]);
      });
      this.db.run('UPDATE playlists SET updated_at = ? WHERE id = ?;', [Date.now(), playlist.id]);
    });

    return {
      playlist,
      removedTrack: target
    };
  }

  deletePlaylist(userId, playlistName) {
    const playlist = this.findOwnedPlaylist(userId, playlistName);
    if (!playlist) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Playlist pribadi bernama **${playlistName}** tidak ditemukan.`,
        { isWarning: true }
      );
    }

    this.db.run('DELETE FROM playlists WHERE id = ?;', [playlist.id]);
    return playlist;
  }

  getGlobalCounts() {
    const pRow = this.db.get('SELECT COUNT(*) AS count FROM playlists;');
    const tRow = this.db.get('SELECT COUNT(*) AS count FROM playlist_tracks;');
    return {
      playlists: Number(pRow?.count || 0),
      tracks: Number(tRow?.count || 0)
    };
  }
}

module.exports = {
  PlaylistRepository
};
