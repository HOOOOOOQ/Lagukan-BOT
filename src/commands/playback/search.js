'use strict';

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require('discord.js');
const { validateVoiceAccess } = require('../../utils/permissions');
const {
  createBaseEmbed,
  buildSuccessEmbed,
  buildTrackAddedEmbed,
  buildWarningEmbed
} = require('../../utils/embeds');
const { formatDuration, truncate, escapeMarkdownLinkText } = require('../../utils/formatters');
const { AppError, ErrorCodes, handleInteractionError } = require('../../utils/errorHandler');
const { config } = require('../../../config/config');

module.exports = {
  category: 'playback',
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Cari lagu dan pilih hasil yang ingin diputar melalui menu interaktif')
    .addStringOption((opt) =>
      opt
        .setName('kata_kunci')
        .setDescription('Judul lagu atau nama artis yang ingin dicari')
        .setRequired(true)
        .setMaxLength(200)
    )
    .addStringOption((opt) =>
      opt
        .setName('sumber')
        .setDescription('Platform pencarian musik (default: YouTube Music)')
        .setRequired(false)
        .addChoices(
          { name: 'YouTube Music', value: 'ytmsearch' },
          { name: 'YouTube', value: 'ytsearch' },
          { name: 'SoundCloud', value: 'scsearch' }
        )
    ),

  async execute(interaction, client) {
    const query = interaction.options.getString('kata_kunci', true).trim();
    const sourcePrefix = interaction.options.getString('sumber') || config.music.defaultSearchSource;

    const existingPlayer = client.playerManager.get(interaction.guildId);
    validateVoiceAccess(interaction, existingPlayer, { requireBotInVoice: false });
    const node = client.playerManager.requireAvailableNode();

    await interaction.deferReply();

    const results = await client.sourceResolver.searchTracks(
      node,
      query,
      sourcePrefix,
      10,
      interaction.user
    );

    if (results.length === 0) {
      throw new AppError(
        ErrorCodes.TRACK_NOT_FOUND,
        `Tidak ditemukan hasil pencarian untuk **"${query}"**.`
      );
    }

    const lines = results.map((track, idx) => {
      const title = escapeMarkdownLinkText(truncate(track.info.title, 65));
      const link = track.info.uri ? `[${title}](${track.info.uri})` : `**${title}**`;
      const dur = formatDuration(track.info.length, track.info.isStream);
      return `\`${String(idx + 1).padStart(2, '0')}.\` ${link} — *${truncate(track.info.author, 35)}* \`[${dur}]\``;
    });

    const searchEmbed = createBaseEmbed(config.colors.primary)
      .setTitle(`🔍 Hasil Pencarian: "${truncate(query, 80)}"`)
      .setDescription(
        `Pilih salah satu lagu pada menu di bawah dalam waktu **60 detik**:\n\n${lines.join('\n')}`
      );

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`search_select:${interaction.id}`)
      .setPlaceholder('🎵 Pilih lagu untuk diputar...')
      .addOptions(
        results.map((track, idx) => ({
          label: `${idx + 1}. ${truncate(track.info.title, 90)}`,
          description: truncate(
            `${track.info.author} • ${formatDuration(track.info.length, track.info.isStream)}`,
            95
          ),
          value: String(idx)
        }))
      );

    const cancelButton = new ButtonBuilder()
      .setCustomId(`search_cancel:${interaction.id}`)
      .setLabel('Batal')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger);

    const replyMessage = await interaction.editReply({
      embeds: [searchEmbed],
      components: [
        new ActionRowBuilder().addComponents(selectMenu),
        new ActionRowBuilder().addComponents(cancelButton)
      ]
    });

    const collector = replyMessage.createMessageComponentCollector({
      time: 60000
    });

    let resolvedChoice = false;

    collector.on('collect', async (compInteraction) => {
      try {
        if (compInteraction.user.id !== interaction.user.id) {
          await compInteraction.reply({
            embeds: [
              buildWarningEmbed(
                'Bukan Pencarian Anda',
                'Hanya pengguna yang menjalankan `/search` ini yang dapat memilih lagu.'
              )
            ],
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (compInteraction.customId.startsWith('search_cancel:')) {
          resolvedChoice = true;
          collector.stop('cancelled');
          await compInteraction.update({
            embeds: [buildWarningEmbed('Pencarian Dibatalkan', 'Pemilihan lagu telah dibatalkan.')],
            components: []
          });
          return;
        }

        const selectedIdx = Number.parseInt(compInteraction.values[0], 10);
        const chosenTrack = results[selectedIdx];
        if (!chosenTrack) return;

        const currentMp = client.playerManager.get(interaction.guildId);
        const { userChannel } = validateVoiceAccess(compInteraction, currentMp, {
          requireBotInVoice: false
        });

        resolvedChoice = true;
        collector.stop('selected');
        await compInteraction.deferUpdate();

        const musicPlayer = await client.playerManager.getOrCreate({
          guild: interaction.guild,
          voiceChannel: userChannel,
          textChannelId: interaction.channelId
        });

        const wasPlaying = Boolean(musicPlayer.playing && musicPlayer.currentTrack);
        const pos = musicPlayer.queue.enqueue(chosenTrack);

        if (!wasPlaying) {
          await musicPlayer.playIfIdle();
          await interaction.editReply({
            embeds: [
              buildSuccessEmbed(
                'Lagu Dipilih & Diputar',
                `🎶 Memutar **${truncate(chosenTrack.info.title, 120)}** — *${truncate(chosenTrack.info.author, 60)}* di <#${userChannel.id}>.`
              )
            ],
            components: []
          });
        } else {
          await musicPlayer.updatePlayerMessage();
          await interaction.editReply({
            embeds: [buildTrackAddedEmbed(chosenTrack, pos, musicPlayer)],
            components: []
          });
        }
      } catch (err) {
        await handleInteractionError(compInteraction, err, '/search collector');
      }
    });

    collector.on('end', async () => {
      if (resolvedChoice) return;
      await interaction
        .editReply({
          embeds: [
            buildWarningEmbed(
              'Waktu Pemilihan Habis',
              'Tidak ada lagu yang dipilih dalam 60 detik. Gunakan `/search` kembali jika ingin mencari lagu.'
            )
          ],
          components: []
        })
        .catch(() => {});
    });
  }
};
