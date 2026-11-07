'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['config', 'src', 'scripts', 'tests'];

function walkJsFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  const files = [path.join(ROOT, 'index.js')];
  for (const d of TARGET_DIRS) {
    walkJsFiles(path.join(ROOT, d), files);
  }

  console.log(`🔍 Memeriksa syntax & integritas import pada ${files.length} file JavaScript...`);

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });

    const source = fs.readFileSync(file, 'utf8');
    if (/\beval\s*\(/.test(source) && rel !== 'scripts/checkSyntax.js') {
      throw new Error(`Ditemukan penggunaan eval() terlarang di ${rel}`);
    }

    // Uji require() untuk seluruh modul aplikasi (selain tests & scripts ini sendiri)
    if (!rel.startsWith('tests/') && rel !== 'scripts/checkSyntax.js') {
      require(file);
    }
  }

  const { collectCommandPayloads } = require('../src/handlers/deployCommands');
  const payloads = collectCommandPayloads();
  const names = new Set();

  for (const cmd of payloads) {
    if (names.has(cmd.name)) {
      throw new Error(`Nama Slash Command duplikat terdeteksi: /${cmd.name}`);
    }
    names.add(cmd.name);
    if (cmd.description.length < 1 || cmd.description.length > 100) {
      throw new Error(`Deskripsi /${cmd.name} melebihi batas 100 karakter Discord.`);
    }
  }

  console.log(`✅ Seluruh ${files.length} file lolos pemeriksaan syntax & import!`);
  console.log(`✅ Seluruh ${payloads.length} Slash Command tervalidasi dengan skema Discord API!`);
}

main();
