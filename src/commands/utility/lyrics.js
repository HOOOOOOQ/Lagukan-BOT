'use strict';

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { config } = require('../../../config/config');
const { createBaseEmbed } = require('../../utils/embeds');
const { truncate } = require('../../utils/formatters');
const { AppError, ErrorCodes } = require('../../utils/errorHandler');

function cleanSongQuery(rawTitle, rawArtist = '') {
  const cleanedTitle = String(rawTitle || '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/official\s*(music\s*)?(video|audio|lyric[s]?|visualizer)/gi, '')
    .replace(/\b(ft\.?|feat\.?)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanedArtist = String(rawArtist || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  return { cleanedTitle, cleanedArtist };
}

async function fetchLyrics(query, artistHint = '', titleHint = '') {
  // 1. LRCLIB Open Lyrics API (gratis, legal, tanpa API key)
  try {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'LaguKan/1.0.0 (Developer: 666pallxXx)'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        const hit = list.find((item) => item.plainLyrics || item.syncedLyrics);
        if (hit) {
          const text = hit.plainLyrics
            ? hit.plainLyrics
            : String(hit.syncedLyrics || '').replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]\s*/g, '');
          return {
            title: hit.trackName || titleHint || query,
            artist: hit.artistName || artistHint || 'Artis',
            album: hit.albumName || null,
            lyrics: text.trim(),
            provider: 'LRCLIB'
          };
        }
      }
    }
  } catch {
    // Lanjut ke fallback berikutnya
  }

  // 2. Fallback Lyrics.ovh jika memiliki artis & judul
  if (artistHint && titleHint) {
    try {
      const ovhUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(artistHint)}/${encodeURIComponent(titleHint)}`;
      const res = await fetch(ovhUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = await res.json();
        if (json?.lyrics) {
          return {
            title: titleHint,
            artist: artistHint,
            album: null,
            lyrics: String(json.lyrics).trim(),
            provider: 'Lyrics.ovh'
          };
        }
      }
    } catch {
      // Abaikan jika gagal
    }
  }

  return null;
}

function paginateText(text, maxChunkSize = 3500) {
  const lines = String(text || '').split('\n');
  const pages = [];
  let buffer = '';

  for (const line of lines) {
    const next = buffer ? `${buffer}\n${line}` : line;
    if (next.length > maxChunkSize && buffer) {
      pages.push(buffer);
      buffer = line.slice(0, maxChunkSize);
    } else {
      buffer = next;
    }
  }
  if (buffer) pages.push(buffer);
  return pages.length > 0 ? pages : ['Lirik kosong.'];
}

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Tampilkan lirik dari lagu yang sedang diputar atau berdasarkan judul lagu')
    .addStringOption((opt) =>
      opt
        .setName('judul')
        .setDescription('Judul lagu & artis (kosongkan untuk mengambil dari lagu yang sedang diputar)')
        .setRequired(false)
        .setMaxLength(200)
    ),

  async execute(interaction, client) {
    const manualQuery = interaction.options.getString('judul')?.trim();
    const musicPlayer = client.playerManager.get(interaction.guildId);

    let searchQuery = manualQuery;
    let artistHint = '';
    let titleHint = '';

    if (!searchQuery) {
      const current = musicPlayer?.currentTrack;
      if (!current) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'Tidak ada lagu yang sedang diputar. Masukkan judul lagu pada opsi `judul`, contoh: `/lyrics judul:Hindia Evaluasi`.',
          { isWarning: true }
        );
      }
      const cleaned = cleanSongQuery(current.info?.title, current.info?.author);
      titleHint = cleaned.cleanedTitle || current.info?.title || '';
      artistHint = cleaned.cleanedArtist || '';
      searchQuery = `${titleHint} ${artistHint}`.trim();
    }

    await interaction.deferReply();
    const result = await fetchLyrics(searchQuery, artistHint, titleHint);

    if (!result || !result.lyrics) {
      throw new AppError(
        ErrorCodes.TRACK_NOT_FOUND,
        `Lirik untuk **"${truncate(searchQuery, 100)}"** tidak ditemukan.`
      );
    }

    const pages = paginateText(result.lyrics, 3500);
    let currentPage = 0;

    const renderPayload = (pageIdx, disableButtons = false) => {
      const embed = createBaseEmbed(config.colors.info)
        .setTitle(`🎤 ${truncate(result.title, 120)} — ${truncate(result.artist, 80)}`)
        .setDescription(pages[pageIdx])
        .addFields(
          {
            name: '📄 Halaman',
            value: `\`${pageIdx + 1} / ${pages.length}\``,
            inline: true
          },
          {
            name: '📚 Sumber Lirik',
            value: `\`${result.provider}\``,
            inline: true
          }
        );

      if (result.album) {
        embed.addFields({ name: '💿 Album', value: truncate(result.album, 100), inline: true });
      }

      if (pages.length <= 1) {
        return { embeds: [embed], components: [] };
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`lyrics_nav:prev:${interaction.id}`)
          .setEmoji('⬅️')
          .setLabel('Sebelumnya')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disableButtons || pageIdx === 0),
        new ButtonBuilder()
          .setCustomId(`lyrics_nav:next:${interaction.id}`)
          .setEmoji('➡️')
          .setLabel('Berikutnya')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disableButtons || pageIdx >= pages.length - 1)
      );

      return { embeds: [embed], components: [row] };
    };

    const msg = await interaction.editReply(renderPayload(0));
    if (pages.length <= 1) return;

    const collector = msg.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async (btn) => {
      if (btn.customId.includes(':prev:')) {
        currentPage = Math.max(0, currentPage - 1);
      } else {
        currentPage = Math.min(pages.length - 1, currentPage + 1);
      }
      await btn.update(renderPayload(currentPage)).catch(() => {});
    });

    collector.on('end', () => {
      interaction.editReply(renderPayload(currentPage, true)).catch(() => {});
    });
  }
};
