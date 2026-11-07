'use strict';

const { Events, ChannelType, PermissionFlagsBits } = require('discord.js');
const { countHumanListeners } = require('../utils/permissions');
const logger = require('../utils/logger').child('VoiceState');

module.exports = {
  name: Events.VoiceStateUpdate,
  once: false,

  async execute(oldState, newState, client) {
    try {
      const guild = newState.guild || oldState.guild;
      if (!guild || !client.user) return;

      const musicPlayer = client.playerManager.get(guild.id);

      // 1. Perubahan status suara milik Bot sendiri
      if (newState.id === client.user.id) {
        // Bot terputus / dikeluarkan dari voice channel
        if (oldState.channelId && !newState.channelId) {
          if (!musicPlayer) return;

          if (
            musicPlayer.twentyFourSeven &&
            client.playerManager.canAttemptAutoReconnect(guild.id)
          ) {
            const targetChannelId = musicPlayer.voiceChannelId || oldState.channelId;
            const savedTrack = musicPlayer.currentTrack;
            const savedPos = musicPlayer.getCurrentPosition();

            logger.info(`[Guild ${guild.id}] Mode 24/7 aktif — menjadwalkan auto-reconnect ke voice channel...`);

            setTimeout(async () => {
              try {
                const channel =
                  guild.channels.cache.get(targetChannelId) ||
                  (await guild.channels.fetch(targetChannelId).catch(() => null));

                const me = guild.members.me;
                const perms = channel && me ? channel.permissionsFor(me) : null;
                if (
                  !channel ||
                  !perms ||
                  !perms.has(PermissionFlagsBits.ViewChannel) ||
                  !perms.has(PermissionFlagsBits.Connect)
                ) {
                  client.guildsRepo.setTwentyFourSeven(guild.id, { enabled: false });
                  await client.playerManager.destroy(guild.id, { skipLeave: true });
                  return;
                }

                await client.playerManager.destroy(guild.id, { skipLeave: true });
                const reconnected = await client.playerManager.getOrCreate({
                  guild,
                  voiceChannel: channel,
                  textChannelId: musicPlayer.textChannelId
                });

                if (savedTrack) {
                  await reconnected.playSpecificTrack(savedTrack, { startPositionMs: savedPos });
                }
              } catch (err) {
                logger.warn(`[Guild ${guild.id}] Auto-reconnect 24/7 gagal: ${err.message}`);
              }
            }, 2500);

            return;
          }

          logger.info(`[Guild ${guild.id}] Bot keluar dari voice channel, membersihkan sesi pemutar.`);
          await client.playerManager.destroy(guild.id, { skipLeave: true });
          return;
        }

        // Bot dipindahkan ke channel lain oleh moderator server
        if (
          oldState.channelId &&
          newState.channelId &&
          oldState.channelId !== newState.channelId &&
          musicPlayer
        ) {
          musicPlayer.voiceChannelId = newState.channelId;
          logger.info(`[Guild ${guild.id}] Bot dipindahkan ke voice channel ${newState.channelId}`);

          if (musicPlayer.twentyFourSeven) {
            client.guildsRepo.setTwentyFourSeven(guild.id, {
              enabled: true,
              voiceChannelId: newState.channelId,
              textChannelId: musicPlayer.textChannelId
            });
          }

          if (newState.channel?.type === ChannelType.GuildStageVoice && newState.suppress) {
            await newState.setSuppressed(false).catch(() => {});
          }
        }
      }

      // 2. Pantau jumlah pendengar manusia di voice channel tempat bot berada
      if (!musicPlayer || musicPlayer.destroyed) return;

      const botChannel = guild.channels.cache.get(musicPlayer.voiceChannelId);
      if (!botChannel || !botChannel.isVoiceBased()) return;

      const humans = countHumanListeners(botChannel);
      if (humans === 0) {
        if (!musicPlayer.twentyFourSeven) {
          musicPlayer.startEmptyChannelTimer();
        }
      } else {
        musicPlayer.clearEmptyChannelTimer();
      }
    } catch (err) {
      logger.error('Kesalahan pada VoiceStateUpdate listener', err);
    }
  }
};
