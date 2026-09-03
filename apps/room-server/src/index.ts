import { startHostedRoomServer } from './server.js';

startHostedRoomServer().catch(error => {
  console.error(error instanceof Error ? error.name : 'room_server_start_failed');
  process.exitCode = 1;
});

export * from './server.js';
export * from './trust-store.js';
