'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const initSqlJs = require('sql.js');
const { config } = require('../../config/config');
const { SCHEMA_SQL } = require('./schema');
const { AppError, ErrorCodes } = require('../utils/errorHandler');
const logger = require('../utils/logger').child('Database');

class DatabaseManager {
  constructor(filePath = config.database.path) {
    this.filePath = path.resolve(filePath);
    this.SQL = null;
    this.db = null;
    this.inTransaction = false;
    this.initialized = false;
  }

  async init() {
    if (this.initialized && this.db) return this;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.SQL = await initSqlJs();

      if (fs.existsSync(this.filePath)) {
        const buffer = fs.readFileSync(this.filePath);
        this.db = new this.SQL.Database(buffer);
        logger.info(`Database SQLite dimuat dari ${this.filePath}`);
      } else {
        this.db = new this.SQL.Database();
        logger.info(`Membuat database SQLite baru di ${this.filePath}`);
      }

      this.db.run(SCHEMA_SQL);
      this.persist();
      this.initialized = true;
      return this;
    } catch (err) {
      logger.error('Gagal menginisialisasi database SQLite', err);
      throw new AppError(
        ErrorCodes.DATABASE_ERROR,
        'Gagal menginisialisasi database SQLite lokal.',
        { cause: err }
      );
    }
  }

  ensureReady() {
    if (!this.db || !this.initialized) {
      throw new AppError(
        ErrorCodes.DATABASE_ERROR,
        'Database belum siap digunakan.'
      );
    }
  }

  persist() {
    if (!this.db) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Buffer.from(this.db.export());
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.error('Gagal menyimpan perubahan database ke disk', err);
      throw new AppError(
        ErrorCodes.DATABASE_ERROR,
        'Gagal menyimpan perubahan ke database SQLite.',
        { cause: err }
      );
    }
  }

  run(sql, params = []) {
    this.ensureReady();
    try {
      this.db.run(sql, params);
      if (!this.inTransaction) {
        this.persist();
      }
    } catch (err) {
      logger.error(`Query SQL gagal dijalankan: ${sql}`, err);
      throw new AppError(
        ErrorCodes.DATABASE_ERROR,
        'Terjadi kesalahan saat memperbarui data di database.',
        { cause: err }
      );
    }
  }

  get(sql, params = []) {
    this.ensureReady();
    let stmt = null;
    try {
      stmt = this.db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return null;
    } catch (err) {
      logger.error(`Query SELECT satu baris gagal: ${sql}`, err);
      throw new AppError(
        ErrorCodes.DATABASE_ERROR,
        'Terjadi kesalahan saat membaca data dari database.',
        { cause: err }
      );
    } finally {
      if (stmt) stmt.free();
    }
  }

  all(sql, params = []) {
    this.ensureReady();
    let stmt = null;
    try {
      stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } catch (err) {
      logger.error(`Query SELECT daftar baris gagal: ${sql}`, err);
      throw new AppError(
        ErrorCodes.DATABASE_ERROR,
        'Terjadi kesalahan saat membaca daftar data dari database.',
        { cause: err }
      );
    } finally {
      if (stmt) stmt.free();
    }
  }

  transaction(workFn) {
    this.ensureReady();
    if (this.inTransaction) {
      return workFn();
    }

    this.inTransaction = true;
    try {
      this.db.run('BEGIN TRANSACTION;');
      const result = workFn();
      this.db.run('COMMIT;');
      this.inTransaction = false;
      this.persist();
      return result;
    } catch (err) {
      try {
        this.db.run('ROLLBACK;');
      } catch {
        // Abaikan jika rollback sudah otomatis dilakukan
      }
      this.inTransaction = false;
      if (err instanceof AppError) throw err;
      logger.error('Transaksi database dibatalkan karena error', err);
      throw new AppError(
        ErrorCodes.DATABASE_ERROR,
        'Transaksi database gagal diselesaikan.',
        { cause: err }
      );
    }
  }

  ping() {
    this.ensureReady();
    const start = performance.now();
    this.get('SELECT 1 AS ok;');
    return Number((performance.now() - start).toFixed(2));
  }

  close() {
    if (!this.db) return;
    try {
      this.persist();
      this.db.close();
      logger.info('Koneksi database SQLite ditutup dengan aman.');
    } catch (err) {
      logger.warn('Kendala ringan saat menutup database SQLite', err);
    } finally {
      this.db = null;
      this.initialized = false;
    }
  }
}

module.exports = {
  DatabaseManager
};
