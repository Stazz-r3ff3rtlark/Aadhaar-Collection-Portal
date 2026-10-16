'use strict';

// Minimal forward-only migration runner: applies migrations/NNN_name.sql in order and
// records each in schema_migrations with a checksum, so an edited migration is caught.
//
// Usage: npm run migrate   (uses DB_MIGRATION_USER / DB_MIGRATION_PASSWORD if set)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mariadb = require('mariadb');
const { IST_SESSION_SQL } = require('./mariadb-store');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.replace(/\.sql$/, ''), sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

async function migrate({ host, port, user, password, database }, { log = console.log } = {}) {
  const conn = await mariadb.createConnection({
    host, port, user, password, database, multipleStatements: true, dateStrings: true, logParam: false,
  });
  try {
    await conn.query(IST_SESSION_SQL);
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(100) NOT NULL PRIMARY KEY,
      checksum    CHAR(64)     NOT NULL,
      applied_at  DATETIME(3)  NOT NULL COMMENT 'IST'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    const applied = new Map((await conn.query('SELECT version, checksum FROM schema_migrations'))
      .map((r) => [r.version, r.checksum]));

    let count = 0;
    for (const m of listMigrations()) {
      if (applied.has(m.version)) {
        if (applied.get(m.version) !== m.checksum) {
          throw new Error(`Migration ${m.version} was edited after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      log(`Applying ${m.version}`);
      // DDL auto-commits in MariaDB, so a migration is not atomic. Keep each one small.
      await conn.query(m.sql);
      await conn.query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, NOW(3))', [m.version, m.checksum]);
      count += 1;
    }
    log(count ? `Applied ${count} migration(s).` : 'Database is up to date.');
    return count;
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  const { loadEnvFile } = require('../lib/env');
  loadEnvFile();
  const { loadConfig } = require('../config');
  const config = loadConfig();
  migrate({ ...config.db, ...config.migrationDb })
    .then(() => process.exit(0))
    .catch((err) => {
      // The message here is our own or a DDL error (no request data), so it is safe to print.
      console.error(`Migration failed: ${err.code || err.name}: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { migrate, listMigrations };
