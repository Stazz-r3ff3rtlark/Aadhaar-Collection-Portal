'use strict';

// Bootstrap the first admin, who can then add everyone else from the admin console.
//
//   npm run create-admin -- --email someone@alembic.co.in --name "Full Name"
//
// The new admin signs in with an emailed code and can then set a password.

const os = require('node:os');
const { loadEnvFile } = require('../lib/env');

loadEnvFile();

const { loadConfig, ALLOWED_EMAIL_DOMAIN } = require('../config');
const { createPool, createMariaDbStore } = require('../db/mariadb-store');
const { createAuditService } = require('../audit/audit-service');
const { systemClock, toIstSql } = require('../lib/time');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg('email') || '').trim().toLowerCase();
  const name = (arg('name') || '').trim();
  if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`) || !name) {
    console.error(`Usage: npm run create-admin -- --email someone@${ALLOWED_EMAIL_DOMAIN} --name "Full Name"`);
    process.exit(2);
  }

  const config = loadConfig();
  const store = createMariaDbStore(createPool(config.db));
  const audit = createAuditService({ clock: systemClock });
  try {
    const id = await store.transaction(async (tx) => {
      if (await tx.users.findByEmail(email)) throw new Error(`${email} is already on the allow-list`);
      const now = toIstSql(systemClock.now());
      const userId = await tx.users.insert({ email, name, role: 'admin', isActive: true, createdAt: now, updatedAt: now });
      await audit.record(tx, {
        actorType: 'system',
        actorLabel: `cli:create-admin (os user ${os.userInfo().username})`,
        action: 'admin.users.create',
        outcome: 'success',
        entityType: 'user',
        entityId: String(userId),
        details: { new: { email, name, role: 'admin' }, via: 'cli' },
      });
      return userId;
    });
    console.log(`Admin created (user id ${id}). They can now sign in with an emailed code.`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(`create-admin failed: ${err.code || err.name}: ${err.message}`);
  process.exit(1);
});
