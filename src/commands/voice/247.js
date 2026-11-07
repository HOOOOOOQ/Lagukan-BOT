'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');

module.exports = {
  category: 'voice',
  data: new SlashCommandBuilder()
    .setName('247')
    .setDescription('Aktifkan atau nonaktifkan mode 24/7 agar LaguKan tetap siaga di voice channel')
    .addStringOption((opt) =>
      opt
        .setName('status')
        .setDescription('Pilih status mode 24/7 (kosongkan untuk toggle otomatis)')
        .setRequired(false)
        .addChoices(
          { name: 'Aktif (ON)', value: 'on' },
          { name: 'Nonaktif (OFF)', value: 'off' }
        )
    ),

  async execute(interaction, client) {
    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    const existing = client.playerManager.get(interaction.guildId);

    assertControlPermission(interaction, existing, guildSettings, 'admin_or_dj');

    const requested = interaction.options.getString('status');
    const currentState = existing ? existing.twentyFourSeven : Boolean(guildSettings.twenty_four_seven);
    const nextState = requested ? requested === 'on' : !currentState;

    if (nextState) {
      const { userChannel } = validateVoiceAccess(interaction, existing, {
        requireBotInVoice: false
      });

      await interaction.deferReply();
      const musicPlayer = await client.playerManager.getOrCreate({
        guild: interaction.guild,
        voiceChannel: userChannel,
        textChannelId: interaction.channelId
      });

      musicPlayer.twentyFourSeven = true;
      musicPlayer.clearIdleTimer();
      musicPlayer.clearEmptyChannelTimer();

      client.guildsRepo.setTwentyFourSeven(interaction.guildId, {
        enabled: true,
        voiceChannelId: userChannel.id,
        textChannelId: interaction.channelId
      });

      await musicPlayer.updatePlayerMessage();

      return interaction.editReply({
        embeds: [
          buildSuccessEmbed(
            'Mode 24/7 Diaktifkan',
            `🌙 Mode **24/7** sekarang **AKTIF** untuk <#${userChannel.id}>.\nLaguKan akan tetap berada di voice channel dan otomatis bergabung kembali saat restart.`
          )
        ]
      });
    }

    client.guildsRepo.setTwentyFourSeven(interaction.guildId, { enabled: false });

    if (existing) {
      existing.twentyFourSeven = false;
      if (!existing.playing) {
        existing.startIdleTimer();
      }
      await existing.updatePlayerMessage();
    }

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Mode 24/7 Dinonaktifkan',
          '☀️ Mode **24/7** sekarang **NONAKTIF**. LaguKan akan keluar otomatis saat antrean selesai atau voice channel kosong.'
        )
      ]
    });
  }
};
