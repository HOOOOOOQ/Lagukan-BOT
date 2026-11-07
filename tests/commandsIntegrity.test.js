'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { config } = require('../config/config');
const { LaguKanClient } = require('../src/client');

const REQUIRED_COMMANDS = [
  // Playback (10)
  'play',
  'search',
  'pause',
  'resume',
  'skip',
  'stop',
  'previous',
  'seek',
  'volume',
  'nowplaying',
  // Queue (8)
  'queue',
  'shuffle',
  'loop',
  'remove',
  'clear',
  'move',
  'jump',
  'replay',
  // Voice (4)
  'join',
  'disconnect',
  '247',
  'autoplay',
  // Music Utility (5 + dj)
  'lyrics',
  'filter',
  'playlist',
  'saveplaylist',
  'loadplaylist',
  'dj',
  // Information (6)
  'help',
  'ping',
  'botinfo',
  'serverinfo',
  'stats',
  'debugmusic'
];

test('Integritas Identitas, LaguKanClient, dan Seluruh 34 Slash Commands', async () => {
  assert.equal(config.bot.name, 'LaguKan');
  assert.equal(config.bot.developer, '666pallxXx');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagukan-client-test-'));
  config.database.path = path.join(tmpDir, 'client-test.sqlite');

  const client = new LaguKanClient();

  try {
    await client.init();

    // Pastikan seluruh command yang diminta terdaftar & memiliki execute()
    for (const cmdName of REQUIRED_COMMANDS) {
      const cmd = client.commands.get(cmdName);
      assert.ok(cmd, `Command /${cmdName} wajib tersedia`);
      assert.equal(typeof cmd.execute, 'function', `Command /${cmdName} wajib memiliki fungsi execute()`);

      const json = cmd.data.toJSON();
      assert.equal(json.name, cmdName);
      assert.ok(json.description.length >= 5 && json.description.length <= 100);
    }

    assert.equal(client.commands.size, REQUIRED_COMMANDS.length);

    // Uji eksekusi /botinfo secara langsung dengan mock interaction
    let botInfoReply = null;
    await client.commands.get('botinfo').execute(
      {
        reply: async (payload) => {
          botInfoReply = payload;
        }
      },
      client
    );

    assert.ok(botInfoReply);
    const embedJson = botInfoReply.embeds[0].toJSON();
    const fieldsStr = JSON.stringify(embedJson);
    assert.match(fieldsStr, /LaguKan/);
    assert.match(fieldsStr, /666pallxXx/);

    // Uji eksekusi /help untuk detail satu command (/play)
    let helpReply = null;
    await client.commands.get('help').execute(
      {
        options: {
          getString: () => 'play'
        },
        reply: async (payload) => {
          helpReply = payload;
        }
      },
      client
    );
    assert.ok(helpReply);
    assert.match(JSON.stringify(helpReply.embeds[0].toJSON()), /\/play/);
  } finally {
    await client.shutdown('TEST_DONE');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
