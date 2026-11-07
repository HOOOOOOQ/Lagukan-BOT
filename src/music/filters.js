'use strict';

/**
 * Daftar preset Audio Filter resmi Lavalink v4 untuk LaguKan.
 */
const FILTER_PRESETS = Object.freeze({
  off: {
    key: 'off',
    label: 'Normal (Tanpa Filter)',
    description: 'Mereset seluruh efek audio kembali normal.',
    payload: {}
  },
  bassboost: {
    key: 'bassboost',
    label: 'Bass Boost',
    description: 'Memperkuat frekuensi bass rendah agar lebih bertenaga.',
    payload: {
      equalizer: [
        { band: 0, gain: 0.25 },
        { band: 1, gain: 0.35 },
        { band: 2, gain: 0.30 },
        { band: 3, gain: 0.18 },
        { band: 4, gain: 0.05 },
        { band: 5, gain: -0.05 }
      ]
    }
  },
  nightcore: {
    key: 'nightcore',
    label: 'Nightcore',
    description: 'Meningkatkan tempo (speed) dan nada (pitch) lagu.',
    payload: {
      timescale: {
        speed: 1.25,
        pitch: 1.25,
        rate: 1.0
      }
    }
  },
  vaporwave: {
    key: 'vaporwave',
    label: 'Vaporwave / Slowed',
    description: 'Memperlambat tempo dan menurunkan pitch bernuansa chill/reverb.',
    payload: {
      timescale: {
        speed: 0.85,
        pitch: 0.82,
        rate: 1.0
      },
      equalizer: [
        { band: 0, gain: 0.15 },
        { band: 1, gain: 0.15 }
      ]
    }
  },
  '8d': {
    key: '8d',
    label: '8D Audio',
    description: 'Efek rotasi suara mengelilingi kepala (gunakan headphone).',
    payload: {
      rotation: {
        rotationHz: 0.2
      }
    }
  },
  karaoke: {
    key: 'karaoke',
    label: 'Karaoke',
    description: 'Meredam frekuensi vokal utama pada lagu.',
    payload: {
      karaoke: {
        level: 1.0,
        monoLevel: 1.0,
        filterBand: 220.0,
        filterWidth: 100.0
      }
    }
  },
  tremolo: {
    key: 'tremolo',
    label: 'Tremolo',
    description: 'Efek alunan amplitudo volume bergetar lembut.',
    payload: {
      tremolo: {
        frequency: 4.0,
        depth: 0.6
      }
    }
  },
  vibrato: {
    key: 'vibrato',
    label: 'Vibrato',
    description: 'Efek osilasi nada bergetar.',
    payload: {
      vibrato: {
        frequency: 4.0,
        depth: 0.5
      }
    }
  },
  soft: {
    key: 'soft',
    label: 'Soft / Lo-Fi',
    description: 'Menghaluskan frekuensi tajam menggunakan low-pass filter.',
    payload: {
      lowPass: {
        smoothing: 20.0
      }
    }
  },
  pop: {
    key: 'pop',
    label: 'Pop EQ',
    description: 'Equalizer vokal jernih dan mid-range seimbang.',
    payload: {
      equalizer: [
        { band: 0, gain: -0.05 },
        { band: 1, gain: 0.08 },
        { band: 2, gain: 0.15 },
        { band: 3, gain: 0.18 },
        { band: 4, gain: 0.12 },
        { band: 5, gain: -0.03 },
        { band: 6, gain: -0.05 }
      ]
    }
  },
  rock: {
    key: 'rock',
    label: 'Rock EQ',
    description: 'Equalizer hentakan drum rendah dan treble gitar tajam.',
    payload: {
      equalizer: [
        { band: 0, gain: 0.25 },
        { band: 1, gain: 0.20 },
        { band: 2, gain: 0.08 },
        { band: 3, gain: -0.08 },
        { band: 4, gain: -0.05 },
        { band: 5, gain: 0.10 },
        { band: 6, gain: 0.22 },
        { band: 7, gain: 0.25 }
      ]
    }
  },
  electronic: {
    key: 'electronic',
    label: 'Electronic / EDM',
    description: 'Equalizer sub-bass dalam dan frekuensi tinggi berkilau.',
    payload: {
      equalizer: [
        { band: 0, gain: 0.30 },
        { band: 1, gain: 0.25 },
        { band: 2, gain: 0.05 },
        { band: 3, gain: 0.0 },
        { band: 4, gain: -0.10 },
        { band: 5, gain: 0.15 },
        { band: 6, gain: 0.20 },
        { band: 7, gain: 0.25 }
      ]
    }
  }
});

function getFilterPreset(key) {
  const normalized = String(key || 'off').trim().toLowerCase();
  return FILTER_PRESETS[normalized] || null;
}

function getFilterChoices() {
  return Object.values(FILTER_PRESETS).map((preset) => ({
    name: preset.label,
    value: preset.key
  }));
}

module.exports = {
  FILTER_PRESETS,
  getFilterPreset,
  getFilterChoices
};
