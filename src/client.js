'use strict';

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const { config, validateConfig } = require('../config/config');
const {
  lavalinkConfig,
  getLavalinkNodes,
  validateLavalinkConfig
} = require('../config/lavalink');
const {
  installShoukakuPatches,
  attachNodeMetadata
} = require('./music/lavalinkTransport');
const { DatabaseManager } = require('./database/database');
const { GuildRepository } = require('./database/guildRepository');
const { PlaylistRepository } = require('./database/playlistRepository');
const { SourceResolver } = require('./music/sourceResolver');
const { PlayerManager } = require('./music/playerManager');
const { AudioDiagnostics } = require('./music/audioDiagnostics');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');
const { globalRateLimiter } = require('./utils/rateLimiter');
const logger = require('./utils/logger');

class LaguKanClient extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });

    // Pasang perbaikan low-level Shoukaku (connectError bug, HTTP 401 auth handler, & voice handshake race fix)
    installShoukakuPatches();

    this.commands = new Collection();
    this.bootTimestamp = Date.now();

    this.db = new DatabaseManager(config.database.path);
    this.guildsRepo = new GuildRepository(this.db);
    this.playlistsRepo = new PlaylistRepository(this.db);
    this.audioDiagnostics = new AudioDiagnostics();
    this.sourceResolver = new SourceResolver(this.audioDiagnostics);

    const nodes = getLavalinkNodes();
    const shoukakuNodes = nodes.map((n) => ({
      name: n.name,
      url: n.url,
      auth: n.auth || 'missing_password',
      secure: n.secure
    }));

    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(this),
      shoukakuNodes,
      lavalinkConfig.shoukakuOptions
    );

    this.once('clientReady', () => {
      attachNodeMetadata(this.shoukaku, getLavalinkNodes());
    });

    this.playerManager = new PlayerManager(this);
    this.presenceInterval = null;
    this.lavalinkHealthTimer = null;
    this.initialized = false;
    this.shuttingDown = false;
  }

  async init() {
    if (this.initialized) return;

    await this.db.init();
    loadCommands(this);
    loadEvents(this);
    this.initialized = true;
  }

  async start() {
    const discordCheck = validateConfig(config);
    if (!discordCheck.valid) {
      throw new Error(
        `Variabel environment wajib belum diisi: ${discordCheck.missing.join(', ')}. Salin .env.example menjadi .env dan lengkapi nilainya.`
      );
    }

    const freshLavalinkCheck = validateLavalinkConfig({
      ...lavalinkConfig,
      nodes: getLavalinkNodes()
    });
    if (!freshLavalinkCheck.valid) {
      for (const issue of freshLavalinkCheck.issues) {
        logger.warn(issue);
      }
    }

    await this.init();
    logger.info(`Menghubungkan ${config.bot.name} ke Discord Gateway...`);
    await this.login(config.bot.token);
  }

  async shutdown(signal = 'SIGTERM') {
    this.shuttingDown = true;
    logger.info(`Menerima sinyal ${signal}. Menutup ${config.bot.name} dengan aman...`);

    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
      this.presenceInterval = null;
    }

    if (this.lavalinkHealthTimer) {
      clearInterval(this.lavalinkHealthTimer);
      this.lavalinkHealthTimer = null;
    }

    globalRateLimiter.destroy();

    try {
      await this.playerManager.destroyAll();
    } catch (err) {
      logger.warn('Kendala ringan saat menutup sesi pemutar musik', err);
    }

    // Tutup seluruh koneksi WebSocket node Lavalink agar proses berhenti seketika tanpa loop reconnect
    if (this.shoukaku?.nodes) {
      for (const node of this.shoukaku.nodes.values()) {
        try {
          node._shuttingDown = true;
          node.cleanupWebsocket();
          node.removeAllListeners();
        } catch {
          // Abaikan
        }
      }
      this.shoukaku.nodes.clear();
    }

    this.db.close();

    try {
      await this.destroy();
    } catch {
      // Abaikan jika sudah tertutup
    }

    logger.info(`${config.bot.name} telah berhenti dengan bersih.`);
  }
}

module.exports = {
  LaguKanClient
};
