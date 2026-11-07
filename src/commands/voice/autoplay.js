'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');

module.exports = {
  category: 'voice',
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Aktifkan atau nonaktifkan pemutaran lagu terkait otomatis saat antrean habis')
    .addStringOption((opt) =>
      opt
        .setName('status')
        .setDescription('Pilih status Autoplay (kosongkan untuk toggle otomatis)')
        .setRequired(false)
        .addChoices(
          { name: 'Aktif (ON)', value: 'on' },
          { name: 'Nonaktif (OFF)', value: 'off' }
        )
    ),

  async execute(interaction, client) {
    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    const musicPlayer = client.playerManager.get(interaction.guildId);

    if (musicPlayer && !musicPlayer.destroyed) {
      validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });
    }

    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    const requested = interaction.options.getString('status');
    const currentState = musicPlayer ? musicPlayer.autoplay : Boolean(guildSettings.autoplay);
    const nextState = requested ? requested === 'on' : !currentState;

    client.guildsRepo.setAutoplay(interaction.guildId, nextState);

    if (musicPlayer) {
      musicPlayer.autoplay = nextState;
      await musicPlayer.updatePlayerMessage();
    }

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          `Autoplay ${nextState ? 'Diaktifkan' : 'Dinonaktifkan'}`,
          nextState
            ? '✨ **Autoplay sekarang AKTIF!** Ketika antrean habis, LaguKan otomatis mencari dan memutar lagu terkait.'
            : '⏹️ **Autoplay sekarang NONAKTIF.** Pemutaran akan berhenti setelah lagu terakhir di antrean selesai.'
        )
      ]
    });
  }
};
