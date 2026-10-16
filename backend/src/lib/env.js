'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Loads backend/.env into process.env if it exists. Real environment variables win. */
function loadEnvFile(file = path.resolve(__dirname, '..', '..', '.env')) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

module.exports = { loadEnvFile };
