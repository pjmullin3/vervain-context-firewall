/**
 * Responsibility: Production/standalone HTTP entrypoint for Vervain Context Firewall.
 * Trust boundary: Binds listening socket on configured PORT and handles clean SIGTERM shutdown.
 */

import { createAppInstance } from './app.js';
import { loadServerConfig } from './config.js';

const config = loadServerConfig();
const { server, context } = createAppInstance({ config });

server.listen(config.port, '0.0.0.0', () => {
  context.logger.record('server_listening', {
    port: config.port,
    mode: context.transport.mode,
    model: config.geminiModel,
    node_env: config.nodeEnv,
  });
});

const shutdown = (): void => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
