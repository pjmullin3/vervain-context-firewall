/**
 * Responsibility: Local single-command development launcher (`npm run dev`) starting both
 * the Node API server on 8080 and the Vite HMR client server on 5173.
 * Trust boundary: Local developer convenience script; excluded from production server build.
 */

import { spawn } from 'node:child_process';

const serverProc = spawn('npx', ['tsx', 'watch', 'src/server/index.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PORT ?? '8080',
    DEMO_MODE: process.env.DEMO_MODE ?? (process.env.GEMINI_API_KEY ? 'live' : 'mock'),
  },
});

const clientProc = spawn('npx', ['vite', '--port', '5173'], {
  stdio: 'inherit',
  env: process.env,
});

const cleanup = (): void => {
  serverProc.kill('SIGTERM');
  clientProc.kill('SIGTERM');
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
