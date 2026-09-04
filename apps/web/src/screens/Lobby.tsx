import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import type { Room } from '@agent-room/shared';
import { ROOM_POLL_MS } from '@agent-room/shared';
import { Avatar } from '../components/Avatar.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { getHostedRoom, issueHostedInvite } from '../room-server-client.js';
import { copyText } from '../lib/copy.js';
import { templateById, roleLabelFor } from '../lib/templates.js';

export function Lobby() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [room, setRoom] = useState<Room | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState('');

  useEffect(() => {
    const stored = sessionStorage.getItem(`room:${code}:self`);
    const self = stored ? JSON.parse(stored) as { name: string; role: string; token: string } : null;

    let cancelled = false;

    async function refresh() {
      try {
        const next = await getHostedRoom(code, self?.token ?? '');
        if (!cancelled) setRoom(next);
      } catch (e) {
        if (cancelled) return;
        setErr(String(e).includes('room_not_found') ? 'Room not found' : String(e));
      }
    }
    if (!self?.token) { setErr('Host session required'); return; }
    issueHostedInvite(code, self.token)
      .then(invite => { if (!cancelled) setJoinUrl(`${window.location.origin}${invite.joinPath}`); })
      .catch(e => { if (!cancelled) setErr(String(e)); });
    refresh();
    const t = setInterval(refresh, ROOM_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [code]);

  const header = (
    <div className="bg-white px-6 py-5">
      <div className="mx-auto max-w-6xl">
        <Link to="/" aria-label="Agent Room home" className="inline-block hover:opacity-85 transition">
          <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" />
        </Link>
      </div>
    </div>
  );

  if (err) return <>{header}<div className="p-10 text-red-600">{err}</div></>;
  if (!room) return <>{header}<div className="p-10 text-ink-soft">Loading…</div></>;

  const inviteText = `Room invite · ${room.topic}\nCode: ${code}\nJoin: ${joinUrl}`;
  const template = templateById(sessionStorage.getItem(`room:pending-template:${code}`));

  return (
    <>
      {header}
      <div className="max-w-md mx-auto mt-10 p-8 bg-surface border border-border rounded-xl shadow-card">
      <h1 className="text-lg font-semibold tracking-tight">Share the room</h1>
      <p className="text-xs text-ink-soft mt-1 mb-5">Anyone with the code can join.</p>

      <div className="bg-surface-soft border border-border rounded-xl p-5 text-center mb-4 relative">
        <div className="text-[9px] uppercase tracking-widest font-semibold text-ink-faint mb-1.5">Meeting code</div>
        <div className="font-mono text-2xl font-bold tracking-[0.06em]">{code}</div>
        <button onClick={() => copyText(code, 'Meeting code copied')}
          className="absolute top-2.5 right-2.5 bg-surface border border-border w-7 h-7 rounded-md text-ink-soft text-xs">⎘</button>
      </div>

      <div className="bg-surface-softer border border-dashed border-border rounded-lg p-3 text-[10px] text-ink-soft leading-relaxed mb-4 relative whitespace-pre-line">
        <button disabled={!joinUrl} onClick={() => copyText(inviteText, 'Invite copied')}
          className="absolute top-2 right-2 bg-surface border border-border px-2 py-0.5 rounded text-[9px] font-semibold text-ink-muted">⎘ Copy</button>
        {inviteText}
      </div>

      <button disabled={!joinUrl} onClick={() => copyText(joinUrl, 'Link copied')}
        className="w-full mb-4 bg-accent-tint text-accent border border-accent/20 py-2 rounded-lg text-xs font-semibold">
        Copy invite link
      </button>

      {template && template.suggestedRoleIds.length > 0 && (
        <div className="mb-6 rounded-lg border border-accent-tint-border bg-accent-tint/40 p-3">
          <div className="text-[10px] font-semibold text-accent-deep mb-2 uppercase tracking-wider flex items-center gap-1.5">
            <span>{template.emoji}</span>
            <span>{template.label} · suggested roles to invite</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {template.suggestedRoleIds.map(rid => (
              <span key={rid} className="text-[10px] font-semibold text-accent bg-white border border-accent-tint-border px-2 py-0.5 rounded">
                {roleLabelFor(rid)}
              </span>
            ))}
          </div>
          <div className="text-[10px] text-ink-soft mt-2 leading-relaxed">
            Share the code with someone (or an agent) and ask them to join in one of these roles.
          </div>
        </div>
      )}

      <div className="mb-6">
        <div className="flex items-center gap-1.5 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-[10px] font-semibold text-ink-muted">Participants · {room.participants.length} here</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {room.participants.map(p => (
            <div key={p.name} className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-soft rounded-md text-xs">
              <Avatar initials={p.initials} color={p.color} size="md" />
              <span className="font-semibold">{p.name}</span>
              {p.role && <span className="text-[9px] text-ink-faint">· {p.role}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => navigate('/')} className="flex-1 bg-surface border border-border py-2.5 rounded-lg text-sm font-semibold text-ink-muted">Invite later</button>
        <button onClick={() => navigate(`/r/${code}`)} className="flex-1 bg-accent text-white py-2.5 rounded-lg text-sm font-semibold">Enter room →</button>
      </div>
      </div>
    </>
  );
}
