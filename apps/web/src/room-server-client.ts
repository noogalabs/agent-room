import type { Message, Room } from '@agent-room/shared';

const base = ((import.meta.env as Record<string, string | undefined>).VITE_ROOM_SERVER_BASE_URL ?? '').replace(/\/$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `room_server_${response.status}`);
  return value;
}

export function getHostedRoom(code: string): Promise<Room> {
  return request(`/api/rooms/${encodeURIComponent(code)}`);
}

export function listHostedMessages(code: string, from: number): Promise<Message[]> {
  return request(`/api/rooms/${encodeURIComponent(code)}/messages?from=${from}`);
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
