'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess } = require('../../utils/permissions');
const { buildSuccessEmbed, buildInfoEmbed } = require('../../utils/embeds');

module.exports = {
  category: 'voice',
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Panggil LaguKan bergabung ke voice channel tempat Anda berada'),

  async execute(interaction, client) {
    const existing = client.playerManager.get(interaction.guildId);
    const { userChannel, botChannelId } = validateVoiceAccess(interaction, existing, {
      requireBotInVoice: false
    });

    if (botChannelId && botChannelId === userChannel.id && existing) {
      return interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Sudah Terhubung',
            `LaguKan sudah berada di voice channel <#${userChannel.id}>.`
          )
        ]
      });
    }

    await interaction.deferReply();
    const musicPlayer = await client.playerManager.getOrCreate({
      guild: interaction.guild,
      voiceChannel: userChannel,
      textChannelId: interaction.channelId
    });

    musicPlayer.startIdleTimer();

    return interaction.editReply({
      embeds: [
        buildSuccessEmbed(
          'Berhasil Bergabung ke Voice Channel',
          `🔊 LaguKan telah bergabung ke <#${userChannel.id}>. Gunakan \`/play\` untuk mulai memutar musik!`
        )
      ]
    });
  }
};
