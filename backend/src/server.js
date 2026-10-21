'use strict';

const fs = require('node:fs');
const { loadEnvFile } = require('./lib/env');

loadEnvFile();

const { loadConfig } = require('./config');
const logger = require('./lib/logger');
const { systemClock } = require('./lib/time');
const { createPool, createMariaDbStore } = require('./db/mariadb-store');
const { createAuditService } = require('./audit/audit-service');
const { createMailer } = require('./mail/mailer');
const { createApp } = require('./app');
const { createFileStore } = require('./files/file-store');

async function main() {
  const config = loadConfig();

  // Private storage for Aadhaar files: inside the backend directory, owner-only, never served by nginx.
  fs.mkdirSync(config.storageDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.storageDir, 0o700);

  const store = createMariaDbStore(createPool(config.db));
  await store.healthCheck();

  const clock = systemClock;
  const app = createApp({
    config,
    store,
    clock,
    audit: createAuditService({ clock }),
    mailer: createMailer(config),
    fileStore: createFileStore({ storageDir: config.storageDir, key: config.fileEncryptionKey }),
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info('api listening', { host: config.host, port: config.port, env: config.nodeEnv });
    if (process.send) process.send('ready'); // pm2 wait_ready
  });

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close(async () => {
      await store.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('startup failed', { ...logger.errorFields(err), detail: err.message?.startsWith('Invalid configuration') ? err.message : undefined });
  process.exit(1);
});
