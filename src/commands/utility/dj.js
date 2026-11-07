'use strict';

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { assertControlPermission } = require('../../utils/permissions');
const { createBaseEmbed, buildSuccessEmbed } = require('../../utils/embeds');
const { config } = require('../../../config/config');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('dj')
    .setDescription('Kelola pengaturan DJ Mode, Role DJ, dan Music Channel khusus server ini')
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('Tampilkan konfigurasi DJ Mode dan pengaturan musik server saat ini')
    )
    .addSubcommand((sub) =>
      sub
        .setName('mode')
        .setDescription('Aktifkan atau nonaktifkan pembatasan kontrol DJ Mode (khusus Admin)')
        .addStringOption((opt) =>
          opt
            .setName('status')
            .setDescription('Status DJ Mode')
            .setRequired(true)
            .addChoices(
              { name: 'Aktif (ON)', value: 'on' },
              { name: 'Nonaktif (OFF)', value: 'off' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('role')
        .setDescription('Tetapkan atau hapus Role DJ untuk server ini (khusus Admin)')
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Pilih Role DJ (kosongkan untuk menghapus penetapan Role DJ)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Batasi perintah musik pada satu text channel tertentu (khusus Admin)')
        .addChannelOption((opt) =>
          opt
            .setName('text_channel')
            .setDescription('Pilih text channel khusus musik (kosongkan untuk mengizinkan semua channel)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Kembalikan seluruh pengaturan musik server ini ke default (khusus Admin)')
    ),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const guildSettings = client.guildsRepo.getSettings(interaction.guildId);
    const musicPlayer = client.playerManager.get(interaction.guildId);

    if (sub === 'info') {
      const embed = createBaseEmbed(config.colors.info)
        .setTitle(`⚙️ Konfigurasi Musik Server: ${interaction.guild.name}`)
        .addFields(
          {
            name: '🔒 DJ Mode',
            value: guildSettings.dj_enabled ? '`AKTIF (ON)`' : '`NONAKTIF (OFF)`',
            inline: true
          },
          {
            name: '🎧 Role DJ',
            value: guildSettings.dj_role_id ? `<@&${guildSettings.dj_role_id}>` : '`Otomatis (Role bernama "DJ")`',
            inline: true
          },
          {
            name: '🔊 Volume Default',
            value: `\`${guildSettings.default_volume}%\``,
            inline: true
          },
          {
            name: '📺 Music Channel',
            value: guildSettings.music_channel_id
              ? `<#${guildSettings.music_channel_id}>`
              : '`Semua Text Channel`',
            inline: true
          },
          {
            name: '🌙 Mode 24/7',
            value: guildSettings.twenty_four_seven
              ? `\`AKTIF\` (${guildSettings.voice_channel_id ? `<#${guildSettings.voice_channel_id}>` : '-'})`
              : '`NONAKTIF`',
            inline: true
          },
          {
            name: '✨ Autoplay Default',
            value: guildSettings.autoplay ? '`AKTIF`' : '`NONAKTIF`',
            inline: true
          }
        );

      return interaction.reply({ embeds: [embed] });
    }

    // Subcommand perubahan konfigurasi wajib Administrator / Manage Guild
    assertControlPermission(interaction, musicPlayer, guildSettings, 'admin');

    if (sub === 'mode') {
      const enabled = interaction.options.getString('status', true) === 'on';
      client.guildsRepo.setDjMode(interaction.guildId, enabled);

      return interaction.reply({
        embeds: [
          buildSuccessEmbed(
            `DJ Mode ${enabled ? 'Diaktifkan' : 'Dinonaktifkan'}`,
            enabled
              ? '🔒 **DJ Mode sekarang AKTIF.** Pengguna biasa tidak dapat menghentikan atau mengacak antrean secara sembarangan.'
              : '🔓 **DJ Mode sekarang NONAKTIF.** Seluruh pendengar di voice channel yang sama dapat menggunakan kontrol musik.'
          )
        ]
      });
    }

    if (sub === 'role') {
      const role = interaction.options.getRole('role');
      client.guildsRepo.setDjRole(interaction.guildId, role ? role.id : null);

      return interaction.reply({
        embeds: [
          buildSuccessEmbed(
            'Role DJ Diperbarui',
            role
              ? `🎧 Role DJ untuk server ini berhasil diatur ke <@&${role.id}>.`
              : '🎧 Penetapan Role DJ spesifik dihapus (kembali mendeteksi role bernama `DJ`).'
          )
        ]
      });
    }

    if (sub === 'channel') {
      const channel = interaction.options.getChannel('text_channel');
      client.guildsRepo.setMusicChannel(interaction.guildId, channel ? channel.id : null);

      return interaction.reply({
        embeds: [
          buildSuccessEmbed(
            'Music Channel Diperbarui',
            channel
              ? `📺 Perintah musik sekarang dibatasi pada channel <#${channel.id}>.`
              : '📺 Pembatasan Music Channel dihapus — perintah musik dapat digunakan di semua text channel.'
          )
        ]
      });
    }

    if (sub === 'reset') {
      client.guildsRepo.resetSettings(interaction.guildId);
      if (musicPlayer) {
        musicPlayer.twentyFourSeven = false;
        musicPlayer.autoplay = false;
      }

      return interaction.reply({
        embeds: [
          buildSuccessEmbed(
            'Pengaturan Server Direset',
            '♻️ Seluruh konfigurasi musik server ini telah dikembalikan ke pengaturan awal.'
          )
        ]
      });
    }
  }
};
