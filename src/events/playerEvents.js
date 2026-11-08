'use strict';

const { lavalinkConfig } = require('../../config/lavalink');
const { syncAndHealLavalinkNodes } = require('../music/lavalinkTransport');
const logger = require('../utils/logger').child('Lavalink');

module.exports = {
  register(client) {
    const shoukaku = client.shoukaku;
    if (!shoukaku) return;

    shoukaku.on('ready', async (name, lavalinkResume, libraryResume) => {
      logger.info(
        `[LavalinkWS] ✅ Lavalink WebSocket session READY: node="${name}", lavalinkResume=${lavalinkResume}, libraryResume=${libraryResume}`
      );
      if (client.audioDiagnostics) {
        client.audioDiagnostics.clearNodeNativeStatus(name);
        client.audioDiagnostics.recordNodeAuthStatus(name, {
          authenticated: true,
          error: null,
          updatedAt: Date.now()
        });
      }

      const connectedNode = shoukaku.nodes.get(name);
      if (connectedNode?.rest && typeof connectedNode.rest.getLavalinkInfo === 'function') {
        connectedNode.rest
          .getLavalinkInfo()
          .then((info) => {
            if (info) {
              connectedNode.info = info;
              const pluginSummary = (info.plugins || [])
                .map((p) => `${p.name}@${p.version}`)
                .join(', ') || 'tanpa plugin eksternal';
              logger.info(
                `📦 Info Lavalink "${name}": v${info.version?.semver || '4.x'} | Java ${info.jvm || 'unknown'} | Lavaplayer ${info.lavaplayer || 'unknown'} | Plugins: ${pluginSummary}`
              );
            }
          })
          .catch((err) => {
            logger.debug(`Gagal mengambil /v4/info awal dari node "${name}": ${err.message}`);
          });
      }

      try {
        await client.playerManager.recoverInterruptedPlayers();
        await client.playerManager.restoreTwentyFourSevenSessions();
      } catch (err) {
        logger.warn(`Kendala ringan saat memulihkan sesi setelah node "${name}" siap`, err);
      }
    });

    shoukaku.on('error', (name, error) => {
      const msg = String(error?.message || error || '');
      const isAuthFailure =
        Boolean(error?.isAuthError) ||
        error?.status === 401 ||
        error?.status === 403 ||
        /401|403|Unauthorized|Forbidden|Authentication failed/i.test(msg);

      if (isAuthFailure) {
        if (client.audioDiagnostics) {
          client.audioDiagnostics.recordNodeAuthStatus(name, {
            authenticated: false,
            error: msg,
            updatedAt: Date.now()
          });
          client.audioDiagnostics.recordTrackError({
            guildId: null,
            nodeName: name,
            track: null,
            stage: 'LAVALINK_WS_AUTH',
            rawException: error
          });
        }
        logger.error(
          `[LavalinkWS] ❌ Autentikasi Lavalink GAGAL pada node "${name}"! Periksa kecocokan LAVALINK_PASSWORD di .env dan lavalink.server.password di application.yml (${msg}).`
        );
        return;
      }

      if (/ECONNREFUSED/i.test(msg)) {
        logger.warn(
          `⚠️ Node Lavalink "${name}" belum dapat dijangkau (ECONNREFUSED). Pastikan server Java Lavalink sudah dijalankan.`
        );
        return;
      }

      logger.error(`Error pada node Lavalink "${name}": ${msg}`);
    });

    shoukaku.on('close', (name, code, reason) => {
      logger.warn(
        `[LavalinkWS] Koneksi WebSocket Lavalink "${name}" tertutup (code=${code}, reason=${reason || 'tidak ada alasan'}).`
      );
    });

    shoukaku.on('disconnect', (name, count) => {
      logger.warn(
        `[LavalinkWS] Node Lavalink "${name}" terputus setelah mencoba menyambung ulang (count=${count}). Health Monitor menjadwalkan pendaftaran ulang otomatis...`
      );
      // Shoukaku v4.3.0 menghapus node dari shoukaku.nodes saat event "disconnect" terjadi!
      const retryTimer = setTimeout(() => {
        if (!client.isReady()) return;
        syncAndHealLavalinkNodes(client);
      }, Math.max(3000, lavalinkConfig.shoukakuOptions.reconnectInterval * 1000));
      if (typeof retryTimer.unref === 'function') {
        retryTimer.unref();
      }
    });

    shoukaku.on('reconnecting', (name, reconnectsLeft, reconnectInterval) => {
      logger.info(
        `[LavalinkWS] Menyambung ulang ke node Lavalink "${name}" dalam ${reconnectInterval} detik (sisa percobaan: ${reconnectsLeft})...`
      );
    });

    // Node Health Monitoring: otomatis mendaftarkan ulang node yang terhapus saat disconnect & memuat ulang password baru
    if (client.lavalinkHealthTimer) {
      clearInterval(client.lavalinkHealthTimer);
    }

    client.lavalinkHealthTimer = setInterval(() => {
      if (!client.isReady()) return;
      syncAndHealLavalinkNodes(client);
    }, lavalinkConfig.healthCheckIntervalMs);

    if (typeof client.lavalinkHealthTimer.unref === 'function') {
      client.lavalinkHealthTimer.unref();
    }
  }
};
