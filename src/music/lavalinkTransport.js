'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const WebSocket = require('ws');
const { Shoukaku, Connection, Node, Constants, Utils } = require('shoukaku');
const { getLavalinkNodes, readLocalApplicationYmlAuth, isLoopbackHost } = require('../../config/lavalink');
const logger = require('../utils/logger').child('LavalinkTransport');

/**
 * Memasang perbaikan tingkat rendah pada Shoukaku v4.3.0 untuk:
 * 1. Memperbaiki bug upstream Node.connect() di mana connectError tidak di-reset saat retry berhasil
 *    (yang sebelumnya memutus socket baru & menghapus node secara permanen).
 * 2. Menangkap HTTP 401/403 pada GET /v4/websocket ("Authentication failed"), memeriksa Authorization header,
 *    serta melakukan auto-fallback ke password application.yml lokal apabila host adalah 127.0.0.1.
 * 3. Memperbaiki race condition Discord Voice Gateway ketika VOICE_SERVER_UPDATE tiba sebelum VOICE_STATE_UPDATE
 *    serta mengirim ulang kredensial voice ke Lavalink setiap kali session_id berubah.
 */
function installShoukakuPatches() {
  if (!Shoukaku.prototype._lagukanPatched) {
    Shoukaku.prototype._lagukanPatched = true;

    Shoukaku.prototype.addNode = function patchedAddNode(options) {
      const node = new Node(this, options);
      node._fallbackLocalAuth = options._fallbackLocalAuth || null;
      node._authSource = options._authSource || 'env';
      node.on('debug', (...args) => this.emit('debug', node.name, ...args));
      node.on('reconnecting', (...args) => this.emit('reconnecting', node.name, ...args));
      node.on('error', (...args) => this.emit('error', node.name, ...args));
      node.on('close', (...args) => this.emit('close', node.name, ...args));
      node.on('ready', (...args) => this.emit('ready', node.name, ...args));
      node.on('raw', (...args) => this.emit('raw', node.name, ...args));
      node.on('disconnect', (count) => {
        // Pertahankan node di this.nodes (status DISCONNECTED) agar koneksi tetap persisten & pulih otomatis
        this.emit('disconnect', node.name, count);
      });
      this.nodes.set(node.name, node);
      node.connect().catch((error) => this.emit('error', node.name, error));
      return node;
    };
  }

  if (!Connection.prototype._lagukanPatched) {
    Connection.prototype._lagukanPatched = true;

    Connection.prototype.setStateUpdate = function patchedSetStateUpdate(options = {}) {
      const { session_id, channel_id, self_deaf, self_mute } = options;
      const prevSessionId = this.sessionId;
      const prevChannelId = this.channelId;

      this.lastChannelId = this.channelId?.repeat(1) ?? null;
      this.channelId = channel_id ?? null;

      if (this.channelId && this.lastChannelId !== this.channelId) {
        this.debug(
          `[Voice] <- [Discord] : Channel Moved | Old Channel: ${this.lastChannelId} New Channel: ${this.channelId} Guild: ${this.guildId}`
        );
      }

      if (!this.channelId) {
        this.state = Constants.State.DISCONNECTED;
        this._pendingServerUpdate = null;
        this.debug(`[Voice] <- [Discord] : Channel Disconnected | Guild: ${this.guildId}`);
      }

      this.deafened = Boolean(self_deaf);
      this.muted = Boolean(self_mute);
      this.sessionId = session_id ?? null;

      logger.info(
        `[VoiceState] Voice connection state: guild=${this.guildId}, channel=${this.channelId || 'none'}, sessionReady=${Boolean(this.sessionId)}, deaf=${this.deafened}, mute=${this.muted}`
      );

      // Jika VOICE_SERVER_UPDATE tiba lebih dulu sebelum VOICE_STATE_UPDATE, selesaikan handshake sekarang!
      if (this.sessionId && this._pendingServerUpdate) {
        const pending = this._pendingServerUpdate;
        this._pendingServerUpdate = null;
        this.setServerUpdate(pending);
        return;
      }

      // Jika serverUpdate sudah ada dan session_id / channel_id diperbarui oleh Discord,
      // dorong pembaruan voice ke Lavalink agar Koe tidak memakai sessionId kedaluwarsa!
      if (
        this.channelId &&
        this.sessionId &&
        this.serverUpdate?.endpoint &&
        this.serverUpdate?.token &&
        ((prevSessionId && prevSessionId !== this.sessionId) ||
          (prevChannelId && prevChannelId !== this.channelId))
      ) {
        logger.info(
          `[DiscordVoice] Pembaruan sesi voice terdeteksi (guild=${this.guildId}, channel=${this.channelId}), menyinkronkan ulang ke Lavalink...`
        );
        this.emit('connectionUpdate', Constants.VoiceState.SESSION_READY);
      }
    };

    Connection.prototype.setServerUpdate = function patchedSetServerUpdate(data = {}) {
      if (!data.endpoint) {
        logger.warn(
          `[DiscordVoice] ❌ VOICE_SERVER_UPDATE diterima tanpa endpoint untuk guild=${this.guildId}`
        );
        this.emit('connectionUpdate', Constants.VoiceState.SESSION_ENDPOINT_MISSING);
        return;
      }

      // Cegah kegagalan handshake jika VOICE_SERVER_UPDATE tiba beberapa milidetik sebelum VOICE_STATE_UPDATE
      if (!this.sessionId) {
        this._pendingServerUpdate = data;
        logger.info(
          `[DiscordVoice] ⏳ VOICE_SERVER_UPDATE diterima lebih awal untuk guild=${this.guildId}, menunggu VOICE_STATE_UPDATE (session_id)...`
        );
        return;
      }

      this._pendingServerUpdate = null;
      this.lastRegion = this.region?.repeat(1) ?? null;
      this.region = data.endpoint.split('.').shift()?.replace(/[0-9]/g, '') ?? null;

      if (this.region && this.lastRegion && this.lastRegion !== this.region) {
        logger.info(
          `[DiscordVoice] Region voice berpindah: ${this.lastRegion} -> ${this.region} (guild=${this.guildId})`
        );
      }

      this.serverUpdate = data;
      const endpointHost = String(data.endpoint).split(':')[0];
      logger.info(
        `[DiscordVoice] ✅ Discord voice connected: guild=${this.guildId}, channel=${this.channelId}, region=${this.region || 'auto'}, endpoint=${endpointHost}`
      );
      this.emit('connectionUpdate', Constants.VoiceState.SESSION_READY);
    };
  }

  if (!Node.prototype._lagukanPatched) {
    Node.prototype._lagukanPatched = true;

    Node.prototype.connect = async function patchedNodeConnect() {
      if (!this.manager.id) {
        throw new Error('UserId bot belum tersedia saat mencoba membuka koneksi Lavalink WebSocket.');
      }
      if (
        this.state === Constants.State.CONNECTED ||
        this.state === Constants.State.CONNECTING
      ) {
        return;
      }

      this.cleanupWebsocket();
      this.state = Constants.State.CONNECTING;

      const buildHeaders = () => {
        const hdrs = {
          'Client-Name': Constants.ShoukakuClientInfo,
          'User-Agent': this.manager.options.userAgent,
          Authorization: String(this.auth || ''),
          'User-Id': String(this.manager.id)
        };
        if (this.sessionId && this.manager.options.resume) {
          hdrs['Session-Id'] = this.sessionId;
        }
        return hdrs;
      };

      const createConnection = () => {
        const headers = buildHeaders();
        if (!headers.Authorization || headers.Authorization === 'missing_password') {
          logger.warn(
            `[LavalinkWS] ⚠️ Header Authorization untuk node "${this.name}" kosong/belum diatur!`
          );
        }

        const wsUrl = new URL(this.url);
        const server = new WebSocket(wsUrl.toString(), { headers });

        server.once('upgrade', (response) => {
          this.open(response);
          const apiVer = response.headers['lavalink-api-version'] || '4';
          const resumed = response.headers['session-resumed'] === 'true';
          logger.info(
            `[LavalinkWS] ✅ Lavalink WebSocket authenticated: node="${this.name}", url="${wsUrl.host}${wsUrl.pathname}", apiVersion=v${apiVer}, resumed=${resumed}`
          );
        });

        server.on('message', (data) => {
          void this.message(data).catch((error) => this.error(error));
        });

        server.on('error', (error) => this.error(error));

        return new Promise((resolve, reject) => {
          let rejectedByUpgradeStatus = false;

          const onUnexpectedResponse = (req, res) => {
            rejectedByUpgradeStatus = true;
            const statusCode = res?.statusCode || 0;
            res?.resume?.();
            server.removeListener('open', onOpen);
            server.removeListener('close', onClose);
            server.removeAllListeners('message');
            server.removeAllListeners('upgrade');
            server.removeAllListeners('error');
            // Wajib pasang no-op error listener agar penutupan socket saat CONNECTING tidak memicu uncaughtException di ws!
            server.on('error', () => {});
            try {
              res?.destroy?.();
              req?.destroy?.();
            } catch {
              // Abaikan
            }

            if (statusCode === 401 || statusCode === 403) {
              const authErr = new Error(
                `HTTP ${statusCode} Authentication failed pada GET /v4/websocket node "${this.name}" (periksa kecocokan LAVALINK_PASSWORD di .env dengan lavalink.server.password di application.yml)`
              );
              authErr.status = statusCode;
              authErr.isAuthError = true;
              reject(authErr);
              return;
            }

            const httpErr = new Error(
              `Handshake WebSocket Lavalink ditolak dengan status HTTP ${statusCode} pada ${this.url}`
            );
            httpErr.status = statusCode;
            reject(httpErr);
          };

          const onOpen = () => {
            server.removeListener('close', onClose);
            server.removeListener('unexpected-response', onUnexpectedResponse);
            resolve(server);
          };

          const onClose = () => {
            if (rejectedByUpgradeStatus) return;
            server.removeListener('open', onOpen);
            server.removeListener('unexpected-response', onUnexpectedResponse);
            server.removeAllListeners('message');
            server.removeAllListeners('upgrade');
            server.removeAllListeners('error');
            server.on('error', () => {});
            reject(new Error(`WebSocket tertutup sebelum koneksi terbentuk ke ${this.url}`));
          };

          server.once('unexpected-response', onUnexpectedResponse);
          server.once('open', onOpen);
          server.once('close', onClose);
        });
      };

      let connectError = null;
      const maxTries = Math.max(1, Number(this.manager.options.reconnectTries || 15));

      for (this.reconnects = 0; this.reconnects < maxTries; this.reconnects += 1) {
        if (this._shuttingDown || this.manager?.connector?.client?.shuttingDown) {
          break;
        }
        try {
          this.ws = await createConnection();
          // KRUSIAL: Reset connectError menjadi null ketika koneksi berhasil pada percobaan ulang!
          connectError = null;
          this._triedFallbackLocalAuth = false;
          break;
        } catch (error) {
          connectError = error;

          // Jika gagal autentikasi (HTTP 401/403) pada localhost, cek apakah application.yml lokal
          // memiliki password yang berbeda dan lakukan auto-recovery instan!
          if (error?.isAuthError) {
            let candidateAuth = this._fallbackLocalAuth || null;
            if (!candidateAuth) {
              try {
                const parsedUrl = new URL(this.url);
                if (isLoopbackHost(parsedUrl.hostname)) {
                  const localYml = readLocalApplicationYmlAuth();
                  if (localYml.found && localYml.password && localYml.password !== this.auth) {
                    candidateAuth = localYml.password;
                  }
                }
              } catch {
                // Abaikan
              }
            }

            if (candidateAuth && candidateAuth !== this.auth && !this._triedFallbackLocalAuth) {
              this._triedFallbackLocalAuth = true;
              this.auth = candidateAuth;
              if (this.rest) {
                this.rest.auth = candidateAuth;
              }
              logger.warn(
                `[LavalinkWS] ⚠️ Autentikasi WebSocket dengan password awal ditolak (HTTP ${error.status}). Mencoba ulang otomatis menggunakan password dari application.yml lokal...`
              );
              continue;
            }

            // Jangan mengulang 15x berturut-turut dengan password yang salah (agar log Lavalink tidak banjir 401)
            logger.error(`[LavalinkWS] ❌ ${error.message}`);
            break;
          }

          const triesLeft = maxTries - this.reconnects - 1;
          if (triesLeft <= 0 || this._shuttingDown || this.manager?.connector?.client?.shuttingDown) {
            break;
          }

          this.emit('reconnecting', triesLeft, this.manager.options.reconnectInterval);
          await Utils.wait(this.manager.options.reconnectInterval * 1000);
        }
      }

      if (connectError || !this.ws) {
        this.state = Constants.State.DISCONNECTED;
        this.cleanupWebsocket();
        let count = 0;
        if (this.manager.options.moveOnDisconnect) {
          count = await this.movePlayers();
        }
        this.emit('disconnect', count);
        throw connectError || new Error('Gagal membuka koneksi WebSocket Lavalink');
      }

      this.ws.once('close', (...args) => void this.close(...args));
    };
  }
}

/**
 * Menyegarkan konfigurasi node dari .env & application.yml lokal serta memastikan node
 * tidak pernah hilang permanen dari pool Shoukaku setelah disconnect/401.
 */
function syncAndHealLavalinkNodes(client) {
  const shoukaku = client?.shoukaku;
  if (!shoukaku || !shoukaku.id) return;

  // Muat ulang .env jika pengguna baru saja memperbaiki LAVALINK_PASSWORD tanpa merestart proses
  dotenv.config({
    path: path.resolve(__dirname, '..', '..', '.env'),
    override: true,
    quiet: true
  });

  const freshNodes = getLavalinkNodes();

  for (const cfg of freshNodes) {
    const existingNode = shoukaku.nodes.get(cfg.name);

    if (!existingNode) {
      logger.info(`[LavalinkWS] Mendaftarkan kembali node Lavalink "${cfg.name}" (${cfg.url})...`);
      shoukaku.addNode({
        name: cfg.name,
        url: cfg.url,
        auth: cfg.auth || 'missing_password',
        secure: cfg.secure
      });
      const newlyAdded = shoukaku.nodes.get(cfg.name);
      if (newlyAdded) {
        newlyAdded._fallbackLocalAuth = cfg._fallbackLocalAuth || null;
      }
      continue;
    }

    existingNode._fallbackLocalAuth = cfg._fallbackLocalAuth || null;

    if (existingNode.state === Constants.State.DISCONNECTED) {
      // Perbarui kredensial apabila pengguna telah mengubah .env atau application.yml
      if (cfg.auth && cfg.auth !== existingNode.auth) {
        existingNode.auth = cfg.auth;
        if (existingNode.rest) existingNode.rest.auth = cfg.auth;
        existingNode._triedFallbackLocalAuth = false;
      }
      logger.debug(`[HealthMonitor] Menyambungkan ulang node "${existingNode.name}"...`);
      existingNode.connect().catch((err) => {
        logger.debug(`[HealthMonitor] Node "${existingNode.name}" belum siap: ${err.message}`);
      });
    }
  }
}

function attachNodeMetadata(shoukaku, nodeConfigs) {
  if (!shoukaku || !Array.isArray(nodeConfigs)) return;
  for (const cfg of nodeConfigs) {
    const node = shoukaku.nodes.get(cfg.name);
    if (node) {
      node._fallbackLocalAuth = cfg._fallbackLocalAuth || null;
    }
  }
}

module.exports = {
  installShoukakuPatches,
  syncAndHealLavalinkNodes,
  attachNodeMetadata
};
