import { loadGatewayConfig } from './config.js';
import { createGatewayServer } from './server.js';

const config = loadGatewayConfig();
const gateway = createGatewayServer(config);

await gateway.start();

console.log(`[gateway] listening on http://${config.host}:${config.port}`);
console.log(`[gateway] upstream ComfyUI: ${config.comfyUrl}`);
console.log(`[gateway] authentication: ${config.allowAnonymous ? 'disabled' : 'enabled'}`);
console.log(`[gateway] dangerous actions: ${config.allowDangerousActions ? 'enabled' : 'disabled'}`);

const shutdown = async (signal) => {
  console.log(`[gateway] received ${signal}; shutting down`);
  await gateway.stop();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
