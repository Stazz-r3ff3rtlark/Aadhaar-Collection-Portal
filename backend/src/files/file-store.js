'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Private, encrypted storage for Aadhaar files (PRD, "Privacy, security and compliance"):
//   - inside the backend directory (storage/aadhaar), never under anything nginx serves;
//   - one folder per booking, so a whole booking is deleted in one operation;
//   - random 64-hex file names: no employee names, codes or Aadhaar numbers;
//   - AES-256-GCM per file, with the file name as associated data so a file cannot be
//     swapped for another one on disk without failing to decrypt.
//
// File layout: "ACP1" | 12-byte IV | 16-byte auth tag | ciphertext.

const MAGIC = Buffer.from('ACP1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STORAGE_KEY = /^[0-9a-f]{64}$/;

function createFileStore({ storageDir, key }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('File encryption key must be 32 bytes');
  const root = path.join(storageDir, 'aadhaar');

  function bookingDir(bookingId) {
    if (!Number.isInteger(bookingId) || bookingId < 1) throw new Error('Invalid booking id for storage');
    return path.join(root, String(bookingId));
  }

  function filePath(bookingId, storageKey) {
    if (!STORAGE_KEY.test(storageKey)) throw new Error('Invalid storage key');
    return path.join(bookingDir(bookingId), `${storageKey}.bin`);
  }

  function encrypt(storageKey, plaintext) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(storageKey));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
  }

  function decrypt(storageKey, data) {
    if (data.length < MAGIC.length + IV_BYTES + TAG_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Stored file is not in the expected format');
    }
    const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = data.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(storageKey));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
  }

  const ignoreMissing = (err) => { if (err.code !== 'ENOENT') throw err; };

  return {
    root,

    /** Encrypts and writes a file; returns its new random storage key. */
    async save(bookingId, plaintext) {
      const storageKey = crypto.randomBytes(32).toString('hex');
      const dir = bookingDir(bookingId);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(filePath(bookingId, storageKey), encrypt(storageKey, plaintext), { mode: 0o600, flag: 'wx' });
      return storageKey;
    },

    async read(bookingId, storageKey) {
      return decrypt(storageKey, await fs.readFile(filePath(bookingId, storageKey)));
    },

    async remove(bookingId, storageKey) {
      await fs.unlink(filePath(bookingId, storageKey)).catch(ignoreMissing);
    },

    /** Removes the booking's whole folder, including anything a failed request left behind. */
    async removeBooking(bookingId) {
      await fs.rm(bookingDir(bookingId), { recursive: true, force: true });
    },

    /** Storage keys present on disk for a booking (to check nothing is left after deletion). */
    async listBooking(bookingId) {
      const names = await fs.readdir(bookingDir(bookingId)).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      });
      return names.filter((n) => n.endsWith('.bin')).map((n) => n.slice(0, -4));
    },
  };
}

module.exports = { createFileStore };
