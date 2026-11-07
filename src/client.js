'use strict';

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const { config, validateConfig } = require('../config/config');
const { lavalinkConfig, validateLavalinkConfig } = require('../config/lavalink');
const { DatabaseManager } = require('./database/database');
const { GuildRepository } = require('./database/guildRepository');
const { PlaylistRepository } = require('./database/playlistRepository');
const { SourceResolver } = require('./music/sourceResolver');
const { PlayerManager } = require('./music/playerManager');
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

    this.commands = new Collection();
    this.bootTimestamp = Date.now();

    this.db = new DatabaseManager(config.database.path);
    this.guildsRepo = new GuildRepository(this.db);
    this.playlistsRepo = new PlaylistRepository(this.db);
    this.sourceResolver = new SourceResolver();

    const shoukakuNodes = lavalinkConfig.nodes.map((n) => ({
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

    this.playerManager = new PlayerManager(this);
    this.presenceInterval = null;
    this.lavalinkHealthTimer = null;
    this.initialized = false;
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

    const lavalinkCheck = validateLavalinkConfig(lavalinkConfig);
    if (!lavalinkCheck.valid) {
      for (const issue of lavalinkCheck.issues) {
        logger.warn(issue);
      }
    }

    await this.init();
    logger.info(`Menghubungkan ${config.bot.name} ke Discord Gateway...`);
    await this.login(config.bot.token);
  }

  async shutdown(signal = 'SIGTERM') {
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
