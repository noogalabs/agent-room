import { readState, type AgentRoomState } from './state.js';
import type { RoomCredentials } from './roomApi.js';

/** Room capabilities recorded in a state snapshot (whichever scope produced it). */
export function credentialsFromState(state: AgentRoomState, code: string): RoomCredentials | undefined {
  const room = state.rooms[code];
  if (!room || (!room.accessToken && !room.participantToken)) return undefined;
  return {
    ...(room.accessToken ? { accessToken: room.accessToken } : {}),
    ...(room.participantToken ? { participantToken: room.participantToken } : {}),
  };
}

/** Room capabilities persisted by earlier joins in this process's PPID-scoped state file. */
export async function stateCredentialLoader(code: string): Promise<RoomCredentials | undefined> {
  return credentialsFromState(await readState(), code);
}
