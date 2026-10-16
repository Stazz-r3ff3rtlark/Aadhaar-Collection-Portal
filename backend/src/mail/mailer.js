'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { randomToken } = require('../lib/crypto');

// Sends mail from support@alembic.co.in (Hostinger SMTP). This M0 mailer covers sign-in
// codes only; the tracked, throttled send queue for invitations and reminders comes later.
// Message content is never logged.
//
// Transports:
//   smtp   - production
//   file   - development: writes .eml files to storage/dev-mail (never in production)
//   memory - tests: keeps messages in mailer.outbox

function createMailer(config) {
  const { transport, from, smtp } = config.mail;

  if (transport === 'memory') {
    const outbox = [];
    return {
      outbox,
      async send(message) {
        outbox.push({ from, ...message });
        return { messageId: `memory-${outbox.length}` };
      },
    };
  }

  if (transport === 'file') {
    const dir = path.join(config.storageDir, 'dev-mail');
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
    return {
      async send(message) {
        const info = await transporter.sendMail({ from, ...message });
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, `${Date.now()}-${randomToken(6)}.eml`), info.message, { mode: 0o600 });
        return { messageId: info.messageId };
      },
    };
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password },
    logger: false,
    debug: false,
  });
  return {
    async send(message) {
      const info = await transporter.sendMail({ from, ...message });
      return { messageId: info.messageId };
    },
  };
}

module.exports = { createMailer };
