'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { AppError, ErrorCodes } = require('./errorHandler');

function isMemberAdmin(member) {
  if (!member?.permissions) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function isMemberDj(member, guildSettings) {
  if (isMemberAdmin(member)) return true;
  if (!member?.roles?.cache) return false;

  if (guildSettings?.dj_role_id && member.roles.cache.has(guildSettings.dj_role_id)) {
    return true;
  }

  // Fallback ramah jika admin mengaktifkan DJ Mode namun belum menetapkan role spesifik: cek role bernama "DJ"
  if (!guildSettings?.dj_role_id) {
    return member.roles.cache.some((r) => r.name.trim().toLowerCase() === 'dj');
  }

  return false;
}

function countHumanListeners(voiceChannel) {
  if (!voiceChannel?.members) return 0;
  return voiceChannel.members.filter((m) => !m.user?.bot).size;
}

/**
 * Memastikan perintah musik dijalankan pada Music Channel jika server mengaturnya.
 */
function validateMusicChannel(interaction, guildSettings) {
  if (!guildSettings?.music_channel_id) return;
  if (interaction.channelId === guildSettings.music_channel_id) return;
  if (isMemberAdmin(interaction.member)) return;

  throw new AppError(
    ErrorCodes.MUSIC_CHANNEL_RESTRICTED,
    `Perintah musik di server ini hanya dapat digunakan di channel <#${guildSettings.music_channel_id}>.`,
    { isWarning: true }
  );
}

/**
 * Memvalidasi keberadaan pengguna di voice channel, kecocokan channel dengan bot, serta izin bot.
 */
function validateVoiceAccess(interaction, musicPlayer, options = {}) {
  const { requireBotInVoice = false, allowAdminOverride = false } = options;

  if (!interaction.inGuild() || !interaction.guild) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Perintah ini hanya dapat digunakan di dalam server Discord.'
    );
  }

  const member = interaction.member;
  const userChannel = member?.voice?.channel;
  const me = interaction.guild.members?.me;
  const botChannelId = musicPlayer?.voiceChannelId || me?.voice?.channelId || null;

  if (!userChannel) {
    if (allowAdminOverride && isMemberAdmin(member) && botChannelId) {
      return { userChannel: null, botChannelId };
    }
    throw new AppError(
      ErrorCodes.USER_NOT_IN_VOICE,
      'Anda harus bergabung ke **Voice Channel** terlebih dahulu sebelum menggunakan perintah musik ini!',
      { isWarning: true }
    );
  }

  if (requireBotInVoice && !botChannelId) {
    throw new AppError(
      ErrorCodes.EMPTY_QUEUE,
      'LaguKan saat ini tidak sedang berada di voice channel.',
      { isWarning: true }
    );
  }

  if (botChannelId && botChannelId !== userChannel.id) {
    throw new AppError(
      ErrorCodes.DIFFERENT_VOICE_CHANNEL,
      `LaguKan sedang digunakan di voice channel <#${botChannelId}>. Silakan bergabung ke channel tersebut untuk mengontrol musik.`,
      { isWarning: true }
    );
  }

  // Jika bot belum terhubung ke channel pengguna, periksa izin masuk & berbicara
  if (!botChannelId && me) {
    const permissions = userChannel.permissionsFor(me);
    if (!permissions) {
      throw new AppError(
        ErrorCodes.BOT_MISSING_PERMISSIONS,
        'LaguKan tidak dapat memeriksa izin pada voice channel Anda.'
      );
    }

    const missing = [];
    if (!permissions.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
    if (!permissions.has(PermissionFlagsBits.Connect)) missing.push('Connect');
    if (
      userChannel.type !== ChannelType.GuildStageVoice &&
      !permissions.has(PermissionFlagsBits.Speak)
    ) {
      missing.push('Speak');
    }

    if (missing.length > 0) {
      throw new AppError(
        ErrorCodes.BOT_MISSING_PERMISSIONS,
        `LaguKan membutuhkan izin **${missing.join(', ')}** pada voice channel <#${userChannel.id}>.`
      );
    }

    if (userChannel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) {
      throw new AppError(
        ErrorCodes.BOT_MISSING_PERMISSIONS,
        `Voice channel <#${userChannel.id}> sudah penuh dan LaguKan tidak memiliki izin **Move Members**.`
      );
    }
  }

  return { userChannel, botChannelId };
}

/**
 * Memeriksa izin DJ Mode, Admin, DJ Role, Requester, dan Solo Listener.
 *
 * @param {'track'|'queue_manage'|'admin_or_dj'|'admin'} scope
 */
function assertControlPermission(interaction, musicPlayer, guildSettings, scope = 'track', targetRequesterId = null) {
  const member = interaction.member;
  const admin = isMemberAdmin(member);

  if (scope === 'admin') {
    if (!admin) {
      throw new AppError(
        ErrorCodes.PERMISSION_DENIED,
        'Hanya **Administrator** atau pengguna dengan izin **Manage Server** yang dapat mengubah pengaturan ini.'
      );
    }
    return true;
  }

  const dj = isMemberDj(member, guildSettings);
  if (scope === 'admin_or_dj') {
    if (!dj) {
      const roleHint = guildSettings?.dj_role_id ? ` (<@&${guildSettings.dj_role_id}>)` : '';
      throw new AppError(
        ErrorCodes.PERMISSION_DENIED,
        `Aksi ini membutuhkan izin **DJ${roleHint}** atau **Administrator**.`
      );
    }
    return true;
  }

  // Jika DJ Mode tidak aktif pada server ini, semua pendengar di voice channel yang sama diizinkan
  const djModeActive = Boolean(guildSettings?.dj_enabled);
  if (!djModeActive) {
    return true;
  }

  if (dj) {
    return true;
  }

  const userVoice = member?.voice?.channel;
  const soloListener = userVoice ? countHumanListeners(userVoice) <= 1 : false;
  if (soloListener) {
    return true;
  }

  const requesterId = targetRequesterId ?? musicPlayer?.currentTrack?.requester?.id ?? null;
  const isRequester = Boolean(requesterId && requesterId === interaction.user.id);

  if (scope === 'track' && isRequester) {
    return true;
  }

  if (scope === 'queue_manage' && targetRequesterId && isRequester) {
    return true;
  }

  const roleText = guildSettings?.dj_role_id
    ? `Role DJ <@&${guildSettings.dj_role_id}>`
    : 'Role DJ';

  throw new AppError(
    ErrorCodes.PERMISSION_DENIED,
    `🔒 **DJ Mode sedang aktif!** Hanya pemilik **${roleText}**, **Administrator**${
      scope === 'track' ? ', atau **pengguna yang meminta lagu ini**' : ''
    } yang dapat melakukan aksi tersebut.`
  );
}

module.exports = {
  isMemberAdmin,
  isMemberDj,
  countHumanListeners,
  validateMusicChannel,
  validateVoiceAccess,
  assertControlPermission
};
