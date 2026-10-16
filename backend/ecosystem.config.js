// pm2 process file for the API.
//
//   pm2 start ecosystem.config.js
//   pm2 reload aadhaar-portal-api
//   pm2 logs aadhaar-portal-api
//
// Secrets live in backend/.env (see .env.example), loaded by the app at startup.
// Logs are JSON lines that never contain Aadhaar content; install pm2-logrotate to cap them.

module.exports = {
  apps: [
    {
      name: 'aadhaar-portal-api',
      cwd: __dirname,
      script: 'src/server.js',
      // One process: scheduled jobs (reminders, nightly deletion) must not run twice.
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 17101,
        // The code never relies on this (IST is explicit everywhere); it only keeps
        // stray stack traces and pm2's own timestamps readable.
        TZ: 'Asia/Kolkata',
      },
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 10000,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 200,
      merge_logs: true,
    },
  ],
};
