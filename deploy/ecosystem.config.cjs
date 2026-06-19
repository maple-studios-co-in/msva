// pm2 process manager config for the MSVA demo.
// From the repo root on the server:
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup   # survive reboots
//
// Each service reads its own apps/<name>/.env via dotenv (cwd-relative), so put
// real secrets there — never in this file.
module.exports = {
  apps: [
    {
      name: "msva-api",
      cwd: "./apps/api",
      script: "dist/server.js",
      node_args: [],
      env: { NODE_ENV: "production" },
      max_restarts: 10,
      restart_delay: 2000,
      time: true
    },
    {
      name: "msva-telephony",
      cwd: "./apps/telephony",
      script: "dist/server.js",
      node_args: [],
      env: { NODE_ENV: "production" },
      max_restarts: 10,
      restart_delay: 2000,
      time: true
    }
  ]
};
