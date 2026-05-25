/** @type {import('next').NextConfig} */
// Polling env vars (WATCHPACK_POLLING, CHOKIDAR_USEPOLLING, TURBOPACK_POLLING) are set in the dev script to fix HMR on WSL2.
const nextConfig = {
  output: "standalone",
  devIndicators: false,
};

module.exports = nextConfig;
