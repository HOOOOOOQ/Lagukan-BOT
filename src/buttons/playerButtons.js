'use strict';

const { MessageFlags } = require('discord.js');
const { config } = require('../../config/config');
const { validateVoiceAccess, assertControlPermission } = require('../utils/permissions');
const { buildQueuePayload, buildInfoEmbed } = require('../utils/embeds');
const { AppError, ErrorCodes } = require('../utils/errorHandler');

/**
 * Menangani seluruh tombol kontrol Music Player (music:*) dan navigasi halaman Queue (queue_nav:*).
 */
async function handlePlayerButton(interaction, client) {
  const customId = interaction.customId || '';

  // Navigasi halaman /queue (queue_nav:prev:2 atau queue_nav:next:1)
  if (customId.startsWith('queue_nav:')) {
    const [, direction, currentPageRaw] = customId.split(':');
    const currentPage = Number.parseInt(currentPageRaw || '1', 10) || 1;
    const nextPage = direction === 'prev' ? Math.max(1, currentPage - 1) : currentPage + 1;

    const musicPlayer = client.playerManager.get(interaction.guildId);
    if (!musicPlayer) {
      return interaction.update({
        embeds: [
          buildInfoEmbed('Antrean Kosong', 'Sesi pemutaran musik telah berakhir.')
        ],
        components: []
      });
    }

    const payload = buildQueuePayload(musicPlayer, nextPage);
    return interaction.update(payload);
  }

  if (!customId.startsWith('music:')) {
    return null;
  }

  const action = customId.slice('music:'.length);
  const musicPlayer = client.playerManager.get(interaction.guildId);

  if (!musicPlayer || musicPlayer.destroyed) {
    throw new AppError(
      ErrorCodes.EMPTY_QUEUE,
      'Sesi pemutar musik sudah berakhir. Gunakan `/play` untuk memulai lagu baru.',
      { isWarning: true }
    );
  }

  // Tombol Queue dapat dibuka oleh siapa saja di server secara ephemeral tanpa mengganggu pendengar lain
  if (action === 'queue') {
    const payload = buildQueuePayload(musicPlayer, 1);
    return interaction.reply({
      ...payload,
      flags: MessageFlags.Ephemeral
    });
  }

  // Seluruh tombol kontrol lainnya mewajibkan pengguna berada di voice channel yang sama dengan bot
  validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });
  const guildSettings = client.guildsRepo.getSettings(interaction.guildId);

  switch (action) {
    case 'pause': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'track');
      await interaction.deferUpdate();
      await musicPlayer.pause();
      break;
    }

    case 'resume': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'track');
      await interaction.deferUpdate();
      await musicPlayer.resume();
      break;
    }

    case 'skip': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'track');
      await interaction.deferUpdate();
      await musicPlayer.skip();
      break;
    }

    case 'previous': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'track');
      await interaction.deferUpdate();
      await musicPlayer.previous();
      break;
    }

    case 'stop': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');
      await interaction.deferUpdate();
      await musicPlayer.stop({ keepConnectionIf247: true });
      break;
    }

    case 'shuffle': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');
      if (musicPlayer.queue.size < 2) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'Minimal dibutuhkan **2 lagu** dalam antrean untuk diacak.',
          { isWarning: true }
        );
      }
      await interaction.deferUpdate();
      musicPlayer.queue.shuffle();
      await musicPlayer.updatePlayerMessage();
      break;
    }

    case 'loop': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');
      await interaction.deferUpdate();
      musicPlayer.queue.cycleLoopMode();
      await musicPlayer.updatePlayerMessage();
      break;
    }

    case 'voldown': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'track');
      await interaction.deferUpdate();
      await musicPlayer.setVolume(musicPlayer.volume - config.music.volumeStep);
      break;
    }

    case 'volup': {
      assertControlPermission(interaction, musicPlayer, guildSettings, 'track');
      await interaction.deferUpdate();
      await musicPlayer.setVolume(musicPlayer.volume + config.music.volumeStep);
      break;
    }

    default:
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Tombol kontrol tidak dikenali.');
  }

  return true;
}

module.exports = {
  handlePlayerButton
};
