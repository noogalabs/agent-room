import type { ClientKind, Message, ReplyMode, ReplyModeConfig, RoleInTurn, Room, RoomReport } from '@agent-room/shared';
import { ENV } from './env.js';

export interface HostedSelf { name: string; role: string; token: string }
export interface HostedTurnState { turnId: number; mode: ReplyMode; currentName?: string; currentClient?: ClientKind; currentRole?: RoleInTurn; deadline?: number; queue: Array<{ name: string; client: ClientKind; role: RoleInTurn }>; spoken: Array<{ name: string; client: ClientKind; role: RoleInTurn; status: string; at: number }> }

const base = ENV.roomServerBaseUrl.replace(/\/$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `room_server_${response.status}`);
  return value;
}

function readHeaders(token: string): HeadersInit { return token ? { authorization: `Bearer ${token}` } : {}; }

export function getHostedRoom(code: string, token: string): Promise<Room> {
  return request(`/api/rooms/${encodeURIComponent(code)}`, { headers: readHeaders(token) });
}

export function listHostedMessages(code: string, from: number, token: string): Promise<Message[]> {
  return request(`/api/rooms/${encodeURIComponent(code)}/messages?from=${from}`, { headers: readHeaders(token) });
}

export async function appendHostedMessage(code: string, token: string, message: Message): Promise<void> {
  await request(`/api/rooms/${encodeURIComponent(code)}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
}

export function exchangeHumanInvite(code: string, inviteToken: string, input: { name: string; role: string; color: string; initials: string }) {
  return request<{ token: string; expiresAt: number; participant: Room['participants'][number] }>(`/api/rooms/${encodeURIComponent(code)}/human-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteToken, ...input }),
  });
}

export function createHostedBrowserRoom(creatorToken: string, input: { code: string; topic: string; name: string; role: string; color: string; initials: string }) {
  return request<{ room: Room; token: string; participant: Room['participants'][number] }>('/api/browser-rooms', {
    method: 'POST', headers: { authorization: `Bearer ${creatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
}

export function issueHostedInvite(code: string, token: string) {
  return request<{ id: string; token: string; joinPath: string }>(`/api/rooms/${encodeURIComponent(code)}/human-invites`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
}

async function action<T>(code: string, token: string, value: Record<string, unknown>): Promise<T> {
  return request<T>(`/api/rooms/${encodeURIComponent(code)}/actions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
}

export const setHostedMuted = (code: string, token: string, targetName: string, targetClient: ClientKind, muted: boolean) => action<Room>(code, token, { action: 'mute', targetName, targetClient, muted });
export const removeHostedParticipant = (code: string, token: string, targetName: string, targetClient: ClientKind) => action<Room>(code, token, { action: 'remove', targetName, targetClient });
export const endHostedRoom = (code: string, token: string) => action<Room>(code, token, { action: 'end' });
export const reactivateHostedRoom = (code: string, token: string) => action<Room>(code, token, { action: 'reactivate' });
export const setHostedReplyMode = (code: string, token: string, mode: ReplyMode, config?: ReplyModeConfig) => action<Room>(code, token, { action: 'reply-mode', mode, config });
export const appendHostedSystemMessage = (code: string, token: string, message: Message) => action<{ sequence: number }>(code, token, { action: 'system-message', message });
export const getHostedTurnState = (code: string, token: string) => action<HostedTurnState | null>(code, token, { action: 'turn-state' });
export const directHostedInvoke = (code: string, token: string, target: { name: string; client: ClientKind }) => action<boolean>(code, token, { action: 'direct-invoke', target });
export const skipHostedCurrent = (code: string, token: string) => action<{ name: string; client: ClientKind; role: RoleInTurn } | null>(code, token, { action: 'skip-current' });
export const getHostedReport = (code: string, token: string) => request<RoomReport | null>(`/api/rooms/${encodeURIComponent(code)}/report`, { headers: readHeaders(token) });
export const createHostedReport = (code: string, token: string) => request<RoomReport>(`/api/rooms/${encodeURIComponent(code)}/report`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
