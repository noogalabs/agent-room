import { readState } from './state.js';
import type { RoomCredentials } from './roomApi.js';

/** Room capabilities persisted by earlier joins in this agent's mode-0600 state file. */
export async function stateCredentialLoader(code: string): Promise<RoomCredentials | undefined> {
  const room = (await readState()).rooms[code];
  if (!room || (!room.accessToken && !room.participantToken)) return undefined;
  return {
    ...(room.accessToken ? { accessToken: room.accessToken } : {}),
    ...(room.participantToken ? { participantToken: room.participantToken } : {}),
  };
}
