'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { config } = require('../../config/config');
const {
  formatDuration,
  createProgressBar,
  formatSourceLabel,
  truncate,
  escapeMarkdownLinkText,
  resolveArtworkUrl,
  formatLoopMode
} = require('./formatters');

const FOOTER_TEXT = `${config.bot.name} • Developer: ${config.bot.developer}`;

function createBaseEmbed(color = config.colors.primary) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

function buildSuccessEmbed(title, description) {
  return createBaseEmbed(config.colors.success)
    .setTitle(`✅ ${title}`)
    .setDescription(description);
}

function buildErrorEmbed(title, description) {
  return createBaseEmbed(config.colors.danger)
    .setTitle(`❌ ${title}`)
    .setDescription(description);
}

function buildWarningEmbed(title, description) {
  return createBaseEmbed(config.colors.warning)
    .setTitle(`⚠️ ${title}`)
    .setDescription(description);
}

function buildInfoEmbed(title, description) {
  return createBaseEmbed(config.colors.primary)
    .setTitle(`🎵 ${title}`)
    .setDescription(description);
}

/**
 * Membangun 10 tombol interaktif Music Player (2 baris x 5 tombol).
 */
function buildPlayerComponents(musicPlayer, disabledAll = false) {
  const isPaused = Boolean(musicPlayer?.paused);
  const hasPrevious = (musicPlayer?.queue?.history?.length || 0) > 0;
  const queueSize = musicPlayer?.queue?.size || 0;
  const loopMode = musicPlayer?.queue?.loopMode || 'off';
  const currentVolume = musicPlayer?.volume ?? config.music.defaultVolume;

  let loopStyle = ButtonStyle.Secondary;
  if (loopMode === 'track') loopStyle = ButtonStyle.Success;
  if (loopMode === 'queue') loopStyle = ButtonStyle.Primary;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music:previous')
      .setEmoji('⏮')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabledAll || !hasPrevious),
    new ButtonBuilder()
      .setCustomId('music:pause')
      .setEmoji('⏸')
      .setLabel('Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabledAll || isPaused),
    new ButtonBuilder()
      .setCustomId('music:resume')
      .setEmoji('▶')
      .setLabel('Resume')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabledAll || !isPaused),
    new ButtonBuilder()
      .setCustomId('music:skip')
      .setEmoji('⏭')
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabledAll),
    new ButtonBuilder()
      .setCustomId('music:stop')
      .setEmoji('⏹')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabledAll)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setEmoji('🔀')
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabledAll || queueSize < 2),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setEmoji('🔁')
      .setLabel(loopMode === 'track' ? 'Loop: Lagu' : loopMode === 'queue' ? 'Loop: Antrean' : 'Loop')
      .setStyle(loopStyle)
      .setDisabled(disabledAll),
    new ButtonBuilder()
      .setCustomId('music:voldown')
      .setEmoji('🔉')
      .setLabel('Volume -')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabledAll || currentVolume <= config.music.minVolume),
    new ButtonBuilder()
      .setCustomId('music:volup')
      .setEmoji('🔊')
      .setLabel('Volume +')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabledAll || currentVolume >= config.music.maxVolume),
    new ButtonBuilder()
      .setCustomId('music:queue')
      .setEmoji('📜')
      .setLabel(`Queue (${queueSize})`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabledAll)
  );

  return [row1, row2];
}

/**
 * Membangun Embed & Tombol interaktif utama untuk lagu yang sedang diputar.
 */
function buildMusicPlayerPayload(musicPlayer, options = {}) {
  const { ended = false } = options;
  const current = musicPlayer?.currentTrack;

  if (!current || ended) {
    const idleEmbed = createBaseEmbed(config.colors.info)
      .setTitle('⏹️ Pemutaran Musik Selesai')
      .setDescription(
        musicPlayer?.twentyFourSeven
          ? 'Antrean telah selesai diputar. Mode **24/7** aktif — LaguKan tetap siaga di voice channel. Gunakan `/play` untuk memutar lagu lagi!'
          : 'Tidak ada lagu yang sedang diputar saat ini. Gunakan `/play` untuk mulai mendengarkan musik!'
      );
    return {
      embeds: [idleEmbed],
      components: buildPlayerComponents(musicPlayer, true)
    };
  }

  const info = current.info || {};
  const titleText = escapeMarkdownLinkText(truncate(info.title || 'Judul Tidak Diketahui', 180));
  const titleDisplay = info.uri ? `[${titleText}](${info.uri})` : `**${titleText}**`;
  const authorDisplay = truncate(info.author || 'Artis Tidak Diketahui', 100);
  const artwork = resolveArtworkUrl(info);
  const currentPos = musicPlayer.getCurrentPosition();
  const durationDisplay = formatDuration(info.length, info.isStream);
  const progressBar = createProgressBar(currentPos, info.length, 15, info.isStream);
  const requesterDisplay = current.requester?.id
    ? `<@${current.requester.id}>`
    : current.requester?.tag || 'Autoplay / Sistem';
  const sourceDisplay = formatSourceLabel(
    current.originalSource || info.sourceName,
    current.matchedVia || null
  );

  const statusText = musicPlayer.paused ? '⏸️ Dijeda' : '▶️ Sedang Diputar';
  const queueRemaining = musicPlayer.queue.size;
  const nextTrack = musicPlayer.queue.peek();
  const nextTrackDisplay = nextTrack
    ? `${truncate(nextTrack.info?.title || 'Lagu Berikutnya', 55)} — *${truncate(nextTrack.info?.author || '', 30)}*`
    : musicPlayer.autoplay
      ? '✨ Autoplay Aktif (Otomatis mencari lagu terkait)'
      : 'Tidak ada lagu berikutnya';

  const embed = createBaseEmbed(musicPlayer.paused ? config.colors.paused : config.colors.playing)
    .setAuthor({
      name: `${config.bot.name} Music Player`
    })
    .setTitle(musicPlayer.paused ? '⏸️ Musik Dijeda' : '🎶 Sedang Memutar Musik')
    .setDescription(
      `### ${titleDisplay}\n` +
      `👤 **Artis:** ${authorDisplay}\n\n` +
      `${progressBar}`
    )
    .addFields(
      { name: '⏱️ Durasi', value: `\`${durationDisplay}\``, inline: true },
      { name: '📡 Sumber Musik', value: sourceDisplay, inline: true },
      { name: '🙋 Diminta Oleh', value: requesterDisplay, inline: true },
      {
        name: '🎚️ Status Playback',
        value: `${statusText} • 🔊 \`${musicPlayer.volume}%\` • ${formatLoopMode(musicPlayer.queue.loopMode)}`,
        inline: true
      },
      {
        name: '🎛️ Filter & Mode',
        value: `Filter: \`${musicPlayer.activeFilterLabel}\` • 24/7: \`${musicPlayer.twentyFourSeven ? 'ON' : 'OFF'}\` • Autoplay: \`${musicPlayer.autoplay ? 'ON' : 'OFF'}\``,
        inline: true
      },
      {
        name: '📋 Posisi Antrean',
        value: `Sedang Diputar • **${queueRemaining}** lagu menunggu\n⏭️ **Berikutnya:** ${nextTrackDisplay}`,
        inline: false
      }
    );

  if (artwork) {
    embed.setThumbnail(artwork);
  }

  return {
    embeds: [embed],
    components: buildPlayerComponents(musicPlayer, false)
  };
}

/**
 * Embed konfirmasi ketika 1 lagu ditambahkan ke antrean.
 */
function buildTrackAddedEmbed(track, position, musicPlayer) {
  const info = track.info || {};
  const titleText = escapeMarkdownLinkText(truncate(info.title || 'Lagu', 180));
  const titleLink = info.uri ? `[${titleText}](${info.uri})` : `**${titleText}**`;
  const artwork = resolveArtworkUrl(info);
  const sourceDisplay = formatSourceLabel(track.originalSource || info.sourceName, track.matchedVia);

  const embed = createBaseEmbed(config.colors.queue)
    .setTitle('➕ Lagu Ditambahkan ke Antrean')
    .setDescription(`### ${titleLink}\n👤 **Artis:** ${truncate(info.author || 'Tidak Diketahui', 100)}`)
    .addFields(
      { name: '⏱️ Durasi', value: `\`${formatDuration(info.length, info.isStream)}\``, inline: true },
      { name: '📍 Posisi Antrean', value: `\`#${position}\``, inline: true },
      { name: '📡 Sumber', value: sourceDisplay, inline: true },
      {
        name: '🙋 Diminta Oleh',
        value: track.requester?.id ? `<@${track.requester.id}>` : 'Pengguna',
        inline: true
      },
      {
        name: '⏳ Estimasi Putar',
        value: `\`${formatDuration(musicPlayer.getEstimatedWaitMs(position - 1))}\``,
        inline: true
      }
    );

  if (artwork) {
    embed.setThumbnail(artwork);
  }

  return embed;
}

/**
 * Embed konfirmasi ketika Playlist / Album ditambahkan ke antrean.
 */
function buildPlaylistAddedEmbed(playlistInfo, addedTracks, requester) {
  const totalDurationMs = addedTracks.reduce(
    (acc, t) => acc + (t.info?.isStream ? 0 : Number(t.info?.length || 0)),
    0
  );
  const firstArtwork = resolveArtworkUrl(addedTracks[0]?.info);

  const embed = createBaseEmbed(config.colors.queue)
    .setTitle('📚 Playlist / Album Ditambahkan ke Antrean')
    .setDescription(`**${truncate(playlistInfo.name || 'Daftar Putar', 180)}**`)
    .addFields(
      { name: '🎵 Jumlah Lagu', value: `\`${addedTracks.length} lagu\``, inline: true },
      { name: '⏱️ Total Durasi', value: `\`${formatDuration(totalDurationMs)}\``, inline: true },
      {
        name: '📡 Sumber',
        value: formatSourceLabel(playlistInfo.source || addedTracks[0]?.originalSource || addedTracks[0]?.info?.sourceName),
        inline: true
      },
      {
        name: '🙋 Diminta Oleh',
        value: requester?.id ? `<@${requester.id}>` : 'Pengguna',
        inline: true
      }
    );

  if (playlistInfo.note) {
    embed.addFields({ name: 'ℹ️ Catatan', value: playlistInfo.note, inline: false });
  }
  if (firstArtwork) {
    embed.setThumbnail(firstArtwork);
  }

  return embed;
}

/**
 * Membangun Embed daftar antrean (paginated) beserta tombol navigasi halaman.
 */
function buildQueuePayload(musicPlayer, requestedPage = 1, pageSize = 10) {
  const current = musicPlayer?.currentTrack;
  const tracks = musicPlayer?.queue?.tracks || [];
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(requestedPage) || 1));

  const startIdx = (page - 1) * pageSize;
  const slice = tracks.slice(startIdx, startIdx + pageSize);

  let description = '';
  if (current) {
    const cInfo = current.info || {};
    const cTitle = escapeMarkdownLinkText(truncate(cInfo.title || 'Lagu', 75));
    const cLink = cInfo.uri ? `[${cTitle}](${cInfo.uri})` : `**${cTitle}**`;
    description +=
      `### 🎶 Sedang Diputar\n` +
      `${cLink} — *${truncate(cInfo.author || 'Tidak Diketahui', 40)}* \`[${formatDuration(cInfo.length, cInfo.isStream)}]\` ` +
      `(${current.requester?.id ? `<@${current.requester.id}>` : 'Autoplay'})\n\n`;
  } else {
    description += `### 🎶 Sedang Diputar\n*Tidak ada lagu yang sedang diputar.*\n\n`;
  }

  description += `### 📜 Antrean Berikutnya (${tracks.length} Lagu)\n`;
  if (slice.length === 0) {
    description += '*Antrean kosong. Tambahkan lagu dengan `/play`!*';
  } else {
    const lines = slice.map((item, idx) => {
      const num = startIdx + idx + 1;
      const tInfo = item.info || {};
      const tTitle = escapeMarkdownLinkText(truncate(tInfo.title || 'Lagu', 55));
      const tLink = tInfo.uri ? `[${tTitle}](${tInfo.uri})` : `**${tTitle}**`;
      const req = item.requester?.id ? `<@${item.requester.id}>` : 'Autoplay';
      return `\`${String(num).padStart(2, '0')}.\` ${tLink} \`[${formatDuration(tInfo.length, tInfo.isStream)}]\` • ${req}`;
    });
    description += lines.join('\n');
  }

  const totalQueueDuration = tracks.reduce(
    (sum, t) => sum + (t.info?.isStream ? 0 : Number(t.info?.length || 0)),
    0
  );

  const embed = createBaseEmbed(config.colors.queue)
    .setTitle(`📜 Antrean Musik Server`)
    .setDescription(description)
    .addFields(
      { name: '📄 Halaman', value: `\`${page} / ${totalPages}\``, inline: true },
      { name: '⏱️ Total Durasi Antrean', value: `\`${formatDuration(totalQueueDuration)}\``, inline: true },
      {
        name: '⚙️ Pengaturan Aktif',
        value:
          `${formatLoopMode(musicPlayer?.queue?.loopMode)} • ` +
          `🔊 \`${musicPlayer?.volume ?? config.music.defaultVolume}%\` • ` +
          `Autoplay: \`${musicPlayer?.autoplay ? 'ON' : 'OFF'}\` • ` +
          `24/7: \`${musicPlayer?.twentyFourSeven ? 'ON' : 'OFF'}\``,
        inline: false
      }
    );

  const components = [];
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`queue_nav:prev:${page}`)
          .setEmoji('⬅️')
          .setLabel('Sebelumnya')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(`queue_nav:next:${page}`)
          .setEmoji('➡️')
          .setLabel('Berikutnya')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages)
      )
    );
  }

  return { embeds: [embed], components };
}

module.exports = {
  FOOTER_TEXT,
  createBaseEmbed,
  buildSuccessEmbed,
  buildErrorEmbed,
  buildWarningEmbed,
  buildInfoEmbed,
  buildPlayerComponents,
  buildMusicPlayerPayload,
  buildTrackAddedEmbed,
  buildPlaylistAddedEmbed,
  buildQueuePayload
};
