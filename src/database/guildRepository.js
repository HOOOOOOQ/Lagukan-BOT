'use strict';

const { config } = require('../../config/config');

class GuildRepository {
  constructor(db) {
    this.db = db;
  }

  createDefaultObject(guildId) {
    const now = Date.now();
    return {
      guild_id: guildId,
      prefix: config.bot.defaultPrefix,
      default_volume: config.music.defaultVolume,
      dj_enabled: 0,
      dj_role_id: null,
      twenty_four_seven: 0,
      voice_channel_id: null,
      text_channel_id: null,
      music_channel_id: null,
      autoplay: 0,
      created_at: now,
      updated_at: now
    };
  }

  getSettings(guildId) {
    if (!guildId) return this.createDefaultObject('global');
    const row = this.db.get(
      'SELECT * FROM guild_settings WHERE guild_id = ?;',
      [String(guildId)]
    );
    if (!row) {
      return this.createDefaultObject(String(guildId));
    }
    return row;
  }

  upsertSettings(guildId, updates = {}) {
    const current = this.getSettings(guildId);
    const now = Date.now();

    const merged = {
      guild_id: String(guildId),
      prefix: updates.prefix !== undefined ? String(updates.prefix) : current.prefix,
      default_volume:
        updates.default_volume !== undefined
          ? Math.max(config.music.minVolume, Math.min(config.music.maxVolume, Number(updates.default_volume)))
          : current.default_volume,
      dj_enabled:
        updates.dj_enabled !== undefined ? (updates.dj_enabled ? 1 : 0) : current.dj_enabled,
      dj_role_id:
        updates.dj_role_id !== undefined ? updates.dj_role_id : current.dj_role_id,
      twenty_four_seven:
        updates.twenty_four_seven !== undefined
          ? (updates.twenty_four_seven ? 1 : 0)
          : current.twenty_four_seven,
      voice_channel_id:
        updates.voice_channel_id !== undefined ? updates.voice_channel_id : current.voice_channel_id,
      text_channel_id:
        updates.text_channel_id !== undefined ? updates.text_channel_id : current.text_channel_id,
      music_channel_id:
        updates.music_channel_id !== undefined ? updates.music_channel_id : current.music_channel_id,
      autoplay:
        updates.autoplay !== undefined ? (updates.autoplay ? 1 : 0) : current.autoplay,
      created_at: current.created_at || now,
      updated_at: now
    };

    this.db.run(
      `INSERT INTO guild_settings (
        guild_id, prefix, default_volume, dj_enabled, dj_role_id,
        twenty_four_seven, voice_channel_id, text_channel_id,
        music_channel_id, autoplay, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        prefix = excluded.prefix,
        default_volume = excluded.default_volume,
        dj_enabled = excluded.dj_enabled,
        dj_role_id = excluded.dj_role_id,
        twenty_four_seven = excluded.twenty_four_seven,
        voice_channel_id = excluded.voice_channel_id,
        text_channel_id = excluded.text_channel_id,
        music_channel_id = excluded.music_channel_id,
        autoplay = excluded.autoplay,
        updated_at = excluded.updated_at;`,
      [
        merged.guild_id,
        merged.prefix,
        merged.default_volume,
        merged.dj_enabled,
        merged.dj_role_id,
        merged.twenty_four_seven,
        merged.voice_channel_id,
        merged.text_channel_id,
        merged.music_channel_id,
        merged.autoplay,
        merged.created_at,
        merged.updated_at
      ]
    );

    return merged;
  }

  setDefaultVolume(guildId, volume) {
    return this.upsertSettings(guildId, { default_volume: volume });
  }

  setDjMode(guildId, enabled) {
    return this.upsertSettings(guildId, { dj_enabled: Boolean(enabled) });
  }

  setDjRole(guildId, roleId) {
    return this.upsertSettings(guildId, { dj_role_id: roleId || null });
  }

  setMusicChannel(guildId, channelId) {
    return this.upsertSettings(guildId, { music_channel_id: channelId || null });
  }

  setTwentyFourSeven(guildId, { enabled, voiceChannelId = null, textChannelId = null }) {
    return this.upsertSettings(guildId, {
      twenty_four_seven: Boolean(enabled),
      voice_channel_id: enabled ? voiceChannelId : null,
      text_channel_id: enabled ? textChannelId : null
    });
  }

  setAutoplay(guildId, enabled) {
    return this.upsertSettings(guildId, { autoplay: Boolean(enabled) });
  }

  setPrefix(guildId, prefix) {
    return this.upsertSettings(guildId, { prefix: String(prefix || '!').slice(0, 5) });
  }

  resetSettings(guildId) {
    const defaults = this.createDefaultObject(guildId);
    return this.upsertSettings(guildId, defaults);
  }

  getTwentyFourSevenGuilds() {
    return this.db.all(
      'SELECT * FROM guild_settings WHERE twenty_four_seven = 1 AND voice_channel_id IS NOT NULL;'
    );
  }
}

module.exports = {
  GuildRepository
};
