import { resolve } from 'node:path';
import { createLocalServer } from './server.js';

export { createLocalServer } from './server.js';
export { DurableStore } from './store.js';

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const dataDir = resolve(process.env.AGENT_ROOM_DATA_DIR ?? '.agent-room-local');
  const hostedBind = process.env.AGENT_ROOM_HOSTED_BIND === '1';
  const host = hostedBind ? (process.env.AGENT_ROOM_BIND_HOST ?? '0.0.0.0') : '127.0.0.1';
  const port = Number(process.env.AGENT_ROOM_PORT ?? process.env.PORT ?? 8787);
  const app = createLocalServer({ dataDir, host, port, hostedBind });
  app.listen().then(({ host, port: bound }) => {
    process.stdout.write(`Agent Room local server listening at http://${host}:${bound}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}
