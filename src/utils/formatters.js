'use strict';

/**
 * Memformat durasi milidetik menjadi string waktu "MM:SS" atau "HH:MM:SS".
 */
function formatDuration(ms, isStream = false) {
  if (isStream) return '🔴 LIVE';
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric < 0) return '00:00';
  if (numeric >= 3600000 * 24 * 7) return '🔴 LIVE';

  const totalSeconds = Math.floor(numeric / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Mengurai input waktu seek seperti "90", "1:30", "01:02:03", atau "2m30s" menjadi milidetik.
 * Mengembalikan null jika format tidak valid.
 */
function parseTimeInput(rawInput) {
  if (rawInput === undefined || rawInput === null) return null;
  const input = String(rawInput).trim().toLowerCase();
  if (!input) return null;

  // Format angka detik murni, misal "90"
  if (/^\d+$/.test(input)) {
    return Number.parseInt(input, 10) * 1000;
  }

  // Format jam/menit/detik dengan huruf, misal "1h2m30s", "2m15s", "45s"
  const unitMatch = input.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/);
  if (unitMatch && (unitMatch[1] || unitMatch[2] || unitMatch[3])) {
    const h = Number.parseInt(unitMatch[1] || '0', 10);
    const m = Number.parseInt(unitMatch[2] || '0', 10);
    const s = Number.parseInt(unitMatch[3] || '0', 10);
    return (h * 3600 + m * 60 + s) * 1000;
  }

  // Format titik dua "MM:SS" atau "HH:MM:SS"
  if (/^\d{1,3}:\d{1,2}(:\d{1,2})?$/.test(input)) {
    const parts = input.split(':').map((p) => Number.parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p) || p < 0)) return null;

    if (parts.length === 2) {
      const [minutes, seconds] = parts;
      if (seconds >= 60) return null;
      return (minutes * 60 + seconds) * 1000;
    }
    if (parts.length === 3) {
      const [hours, minutes, seconds] = parts;
      if (minutes >= 60 || seconds >= 60) return null;
      return (hours * 3600 + minutes * 60 + seconds) * 1000;
    }
  }

  return null;
}

/**
 * Membuat progress bar visual untuk pemutar musik.
 */
function createProgressBar(currentMs, totalMs, barLength = 16, isStream = false) {
  if (isStream || !totalMs || totalMs <= 0) {
    return `🔴 **SIARAN LANGSUNG (LIVE)** • \`${formatDuration(currentMs, false)}\``;
  }

  const clampedCurrent = Math.max(0, Math.min(currentMs, totalMs));
  const ratio = clampedCurrent / totalMs;
  const filledIndex = Math.min(barLength - 1, Math.max(0, Math.round(ratio * (barLength - 1))));

  let bar = '';
  for (let i = 0; i < barLength; i += 1) {
    if (i === filledIndex) {
      bar += '🔘';
    } else if (i < filledIndex) {
      bar += '▬';
    } else {
      bar += '─';
    }
  }

  const percent = Math.round(ratio * 100);
  return `\`${formatDuration(clampedCurrent)}\` ${bar} \`${formatDuration(totalMs)}\` (${percent}%)`;
}

/**
 * Mengembalikan nama sumber musik yang jujur dan rapi dalam Bahasa Indonesia.
 */
function formatSourceLabel(sourceName, matchedVia = null) {
  const normalized = String(sourceName || 'unknown').toLowerCase();
  if (normalized === 'spotify-matched') {
    const via = matchedVia ? ` via ${formatSourceLabel(matchedVia)}` : '';
    return `Spotify (Pencocokan Audio${via})`;
  }
  const map = {
    youtube: 'YouTube',
    youtubemusic: 'YouTube Music',
    ytmusic: 'YouTube Music',
    spotify: 'Spotify (Metadata + Audio Match)',
    soundcloud: 'SoundCloud',
    http: 'Direct Audio URL',
    bandcamp: 'Bandcamp',
    twitch: 'Twitch',
    vimeo: 'Vimeo'
  };
  return map[normalized] || sourceName || 'Sumber Audio';
}

/**
 * Memotong teks panjang dengan aman sesuai batas karakter komponen Discord.
 */
function truncate(text, maxLength = 100) {
  const str = String(text ?? '').trim();
  if (str.length <= maxLength) return str;
  if (maxLength <= 3) return str.slice(0, maxLength);
  return `${str.slice(0, maxLength - 3)}...`;
}

/**
 * Membersihkan karakter markdown link agar judul lagu aman di dalam [Judul](URL).
 */
function escapeMarkdownLinkText(text) {
  return String(text ?? 'Tanpa Judul')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * Mendapatkan URL thumbnail/artwork terbaik untuk lagu.
 */
function resolveArtworkUrl(trackInfo) {
  if (!trackInfo) return null;
  if (trackInfo.artworkUrl && /^https?:\/\//i.test(trackInfo.artworkUrl)) {
    return trackInfo.artworkUrl;
  }
  const source = String(trackInfo.sourceName || '').toLowerCase();
  if ((source.includes('youtube') || source === 'ytmusic') && trackInfo.identifier) {
    return `https://img.youtube.com/vi/${encodeURIComponent(trackInfo.identifier)}/hqdefault.jpg`;
  }
  return null;
}

/**
 * Memformat ukuran memori byte ke MB / GB.
 */
function formatBytes(bytes) {
  const num = Number(bytes || 0);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(2)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Memformat uptime milidetik ke teks Bahasa Indonesia.
 */
function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} hari`);
  if (hours > 0) parts.push(`${hours} jam`);
  if (minutes > 0) parts.push(`${minutes} menit`);
  parts.push(`${seconds} detik`);
  return parts.join(' ');
}

function formatLoopMode(mode) {
  switch (mode) {
    case 'track':
      return '🔂 Lagu Saat Ini';
    case 'queue':
      return '🔁 Seluruh Antrean';
    default:
      return '➡️ Mati';
  }
}

module.exports = {
  formatDuration,
  parseTimeInput,
  createProgressBar,
  formatSourceLabel,
  truncate,
  escapeMarkdownLinkText,
  resolveArtworkUrl,
  formatBytes,
  formatUptime,
  formatLoopMode
};
