'use strict';

const { Constants } = require('shoukaku');
const { lavalinkConfig } = require('../../config/lavalink');
const logger = require('../utils/logger').child('Lavalink');

module.exports = {
  register(client) {
    const shoukaku = client.shoukaku;
    if (!shoukaku) return;

    shoukaku.on('ready', async (name, lavalinkResume, libraryResume) => {
      logger.info(
        `✅ Node Lavalink "${name}" terhubung! (lavalinkResume=${lavalinkResume}, libraryResume=${libraryResume})`
      );
      if (client.audioDiagnostics) {
        client.audioDiagnostics.clearNodeNativeStatus(name);
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
      if (/401|403|Unauthorized|Forbidden/i.test(msg)) {
        logger.error(
          `❌ Autentikasi Lavalink GAGAL pada node "${name}"! Periksa kecocokan LAVALINK_PASSWORD di .env dan application.yml.`
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
        `Koneksi WebSocket Lavalink "${name}" tertutup (code=${code}, reason=${reason || 'tidak ada alasan'}).`
      );
    });

    shoukaku.on('disconnect', (name, count) => {
      logger.warn(
        `Node Lavalink "${name}" terputus setelah mencoba menyambung ulang (count=${count}). Health Monitor akan tetap memantau.`
      );
    });

    shoukaku.on('reconnecting', (name, reconnectsLeft, reconnectInterval) => {
      logger.info(
        `Menyambung ulang ke node Lavalink "${name}" dalam ${reconnectInterval} detik (sisa percobaan: ${reconnectsLeft})...`
      );
    });

    // Node Health Monitoring: otomatis menyambungkan kembali node yang terputus total setelah server Lavalink dinyalakan
    client.lavalinkHealthTimer = setInterval(() => {
      if (!client.isReady()) return;
      for (const node of shoukaku.nodes.values()) {
        if (node.state === Constants.State.DISCONNECTED) {
          logger.debug(`[HealthMonitor] Mencoba menyambungkan kembali node "${node.name}"...`);
          node.connect().catch((err) => {
            logger.debug(`[HealthMonitor] Node "${node.name}" masih offline: ${err.message}`);
          });
        }
      }
    }, lavalinkConfig.healthCheckIntervalMs);

    if (typeof client.lavalinkHealthTimer.unref === 'function') {
      client.lavalinkHealthTimer.unref();
    }
  }
};
