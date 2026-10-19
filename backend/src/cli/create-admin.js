'use strict';

// Bootstrap the first admin, who can then add everyone else from the admin console.
//
//   npm run create-admin -- --email someone@alembic.co.in --name "Full Name" --division "Digilabs"
//
// Every user belongs to one division. Divisions are free names; if none matches the one
// given (ignoring case), it is created. The new admin signs in with an emailed code and
// can then set a password.

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
  const divisionName = (arg('division') || '').trim().replace(/\s+/g, ' ');
  if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`) || !name || !divisionName || divisionName.length > 100) {
    console.error(`Usage: npm run create-admin -- --email someone@${ALLOWED_EMAIL_DOMAIN} --name "Full Name" --division "Division name"`);
    process.exit(2);
  }

  const config = loadConfig();
  const store = createMariaDbStore(createPool(config.db));
  const audit = createAuditService({ clock: systemClock });
  try {
    const id = await store.transaction(async (tx) => {
      if (await tx.users.findByEmail(email)) throw new Error(`${email} is already on the allow-list`);
      const now = toIstSql(systemClock.now());
      const actor = { actorType: 'system', actorLabel: `cli:create-admin (os user ${os.userInfo().username})` };

      let division = await tx.divisions.findByName(divisionName);
      if (division?.archivedAt) throw new Error(`The ${division.name} division is archived. Choose another, or restore it first.`);
      if (!division) {
        const divisionId = await tx.divisions.insert({ name: divisionName, createdAt: now, updatedAt: now });
        await audit.record(tx, {
          ...actor,
          action: 'admin.divisions.create',
          outcome: 'success',
          entityType: 'division',
          entityId: String(divisionId),
          details: { new: { name: divisionName }, via: 'cli' },
        });
        division = { id: divisionId, name: divisionName };
      }

      const userId = await tx.users.insert({
        email, name, role: 'admin', divisionId: division.id, isActive: true, createdAt: now, updatedAt: now,
      });
      await audit.record(tx, {
        ...actor,
        action: 'admin.users.create',
        outcome: 'success',
        entityType: 'user',
        entityId: String(userId),
        details: { new: { email, name, role: 'admin', divisionId: division.id }, via: 'cli' },
      });
      return userId;
    });
    console.log(`Admin created (user id ${id}) in division "${divisionName}". They can now sign in with an emailed code.`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(`create-admin failed: ${err.code || err.name}: ${err.message}`);
  process.exit(1);
});
