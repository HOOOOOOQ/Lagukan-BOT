'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

module.exports = {
  category: 'queue',
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Kosongkan seluruh daftar lagu berikutnya tanpa menghentikan lagu saat ini'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    if (musicPlayer.queue.isEmpty) {
      throw new AppError(ErrorCodes.EMPTY_QUEUE, 'Daftar antrean berikutnya sudah kosong.', {
        isWarning: true
      });
    }

    const removedCount = musicPlayer.queue.clear();
    await musicPlayer.updatePlayerMessage();

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Antrean Dibersihkan',
          `🧹 Berhasil menghapus **${removedCount} lagu** dari daftar tunggu antrean.`
        )
      ]
    });
  }
};
