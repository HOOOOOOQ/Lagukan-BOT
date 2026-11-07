'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { validateVoiceAccess, assertControlPermission } = require('../../utils/permissions');
const { buildSuccessEmbed } = require('../../utils/embeds');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Hentikan pemutaran musik dan bersihkan seluruh antrean'),

  async execute(interaction, client) {
    const musicPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, musicPlayer, { requireBotInVoice: true });

    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    assertControlPermission(interaction, musicPlayer, guildSettings, 'queue_manage');

    const { stayedInChannel } = await musicPlayer.stop({ keepConnectionIf247: true });

    return interaction.reply({
      embeds: [
        buildSuccessEmbed(
          'Pemutaran Musik Dihentikan',
          stayedInChannel
            ? '⏹️ Musik telah dihentikan dan antrean dibersihkan. LaguKan tetap di voice channel karena mode **24/7** aktif.'
            : '⏹️ Musik telah dihentikan, antrean dibersihkan, dan LaguKan keluar dari voice channel.'
        )
      ]
    });
  }
};
