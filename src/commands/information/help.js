'use strict';

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const { config } = require('../../../config/config');
const { createBaseEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

const CATEGORY_META = {
  playback: { emoji: '▶️', title: 'Playback (Pemutaran Musik)' },
  queue: { emoji: '📜', title: 'Queue (Manajemen Antrean)' },
  voice: { emoji: '🔊', title: 'Voice (Koneksi Suara & 24/7)' },
  utility: { emoji: '🎛️', title: 'Music Utility (Filter, Lirik, Playlist & DJ)' },
  information: { emoji: 'ℹ️', title: 'Information (Informasi & Statistik Bot)' }
};

module.exports = {
  category: 'information',
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Tampilkan panduan lengkap daftar perintah Slash Command LaguKan')
    .addStringOption((opt) =>
      opt
        .setName('perintah')
        .setDescription('Nama perintah spesifik untuk melihat detail penggunaannya')
        .setRequired(false)
        .setAutocomplete(true)
        .setMaxLength(50)
    ),

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = [...client.commands.values()]
      .filter((c) => c.data.name.includes(focused))
      .slice(0, 25)
      .map((c) => ({
        name: truncate(`/${c.data.name} — ${c.data.description}`, 100),
        value: c.data.name
      }));
    await interaction.respond(choices);
  },

  async execute(interaction, client) {
    const specificName = interaction.options.getString('perintah')?.trim().toLowerCase();

    if (specificName) {
      const cmd = client.commands.get(specificName);
      if (!cmd) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Perintah \`/${specificName}\` tidak ditemukan. Jalankan \`/help\` tanpa parameter untuk melihat seluruh daftar perintah.`,
          { isWarning: true }
        );
      }

      const json = cmd.data.toJSON();
      const catMeta = CATEGORY_META[cmd.category] || { emoji: '🎵', title: cmd.category };
      const optionsText =
        Array.isArray(json.options) && json.options.length > 0
          ? json.options
              .map(
                (o) =>
                  `• \`${o.name}\`${o.required ? ' *(wajib)*' : ' *(opsional)*'} — ${o.description}`
              )
              .join('\n')
          : '*Tidak memerlukan parameter tambahan.*';

      const detailEmbed = createBaseEmbed(config.colors.primary)
        .setTitle(`📖 Detail Perintah: /${json.name}`)
        .setDescription(json.description)
        .addFields(
          { name: '📂 Kategori', value: `${catMeta.emoji} ${catMeta.title}`, inline: true },
          { name: '⚙️ Parameter / Subcommand', value: optionsText, inline: false }
        );

      return interaction.reply({ embeds: [detailEmbed] });
    }

    const grouped = {};
    for (const cmd of client.commands.values()) {
      const cat = cmd.category || 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(cmd);
    }

    const buildOverviewEmbed = (selectedCat = 'all') => {
      const embed = createBaseEmbed(config.colors.primary)
        .setTitle(`🎵 Pusat Bantuan ${config.bot.name}`)
        .setDescription(
          `**${config.bot.name}** adalah Discord Music Bot modern berbasis Lavalink yang dikembangkan oleh **${config.bot.developer}**.\n` +
          `Cukup masuk ke Voice Channel dan ketik \`/play [judul lagu / URL]\` untuk mulai mendengarkan musik!`
        );

      if (selectedCat === 'all') {
        for (const [catKey, meta] of Object.entries(CATEGORY_META)) {
          const list = (grouped[catKey] || [])
            .map((c) => `\`/${c.data.name}\``)
            .sort()
            .join(', ');
          if (list) {
            embed.addFields({
              name: `${meta.emoji} ${meta.title}`,
              value: list,
              inline: false
            });
          }
        }
      } else {
        const meta = CATEGORY_META[selectedCat] || { emoji: '🎵', title: selectedCat };
        const lines = (grouped[selectedCat] || [])
          .sort((a, b) => a.data.name.localeCompare(b.data.name))
          .map((c) => `• **\`/${c.data.name}\`** — ${c.data.description}`);
        embed.addFields({
          name: `${meta.emoji} ${meta.title}`,
          value: lines.join('\n') || '*Tidak ada perintah.*',
          inline: false
        });
      }

      return embed;
    };

    const buildMenuRow = (disabled = false) =>
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`help_cat:${interaction.id}`)
          .setPlaceholder('📂 Pilih kategori perintah untuk melihat detail...')
          .setDisabled(disabled)
          .addOptions(
            { label: 'Semua Kategori', description: 'Ringkasan seluruh perintah LaguKan', value: 'all', emoji: '📚' },
            ...Object.entries(CATEGORY_META).map(([key, meta]) => ({
              label: meta.title,
              description: `Daftar lengkap perintah kategori ${key}`,
              value: key,
              emoji: meta.emoji
            }))
          )
      );

    await interaction.reply({
      embeds: [buildOverviewEmbed('all')],
      components: [buildMenuRow(false)]
    });

    const msg = await interaction.fetchReply().catch(() => null);
    if (!msg) return;

    const collector = msg.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async (sel) => {
      const cat = sel.values[0] || 'all';
      await sel
        .update({
          embeds: [buildOverviewEmbed(cat)],
          components: [buildMenuRow(false)]
        })
        .catch(() => {});
    });

    collector.on('end', () => {
      interaction.editReply({ components: [buildMenuRow(true)] }).catch(() => {});
    });
  }
};
