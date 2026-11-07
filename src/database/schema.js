'use strict';

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL DEFAULT '!',
  default_volume INTEGER NOT NULL DEFAULT 80,
  dj_enabled INTEGER NOT NULL DEFAULT 0,
  dj_role_id TEXT DEFAULT NULL,
  twenty_four_seven INTEGER NOT NULL DEFAULT 0,
  voice_channel_id TEXT DEFAULT NULL,
  text_channel_id TEXT DEFAULT NULL,
  music_channel_id TEXT DEFAULT NULL,
  autoplay INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE,
  owner_id TEXT NOT NULL,
  owner_tag TEXT NOT NULL,
  guild_id TEXT DEFAULT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  uri TEXT DEFAULT NULL,
  identifier TEXT DEFAULT NULL,
  encoded TEXT DEFAULT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  artwork_url TEXT DEFAULT NULL,
  source_name TEXT NOT NULL DEFAULT 'unknown',
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_id);
CREATE INDEX IF NOT EXISTS idx_playlists_guild_public ON playlists(guild_id, is_public);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pid ON playlist_tracks(playlist_id, position);
`;

module.exports = {
  SCHEMA_SQL
};
