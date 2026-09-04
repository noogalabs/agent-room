import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ROLE_PRESETS } from '@agent-room/shared';
import { createHostedBrowserRoom } from '../room-server-client.js';
import { colorForName, initialsFor } from '../lib/colors.js';
import { ROOM_TEMPLATES, roleLabelFor, templateById } from '../lib/templates.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { persistHumanSeat } from '../lib/human-seat.js';

const TEMPLATE_KEY = 'room:pending-template:';

export function CreateMeeting() {
  // A4: optional `?topic=...&from=<code>` query params let the report
  // page deep-link a reader straight into a new-room flow with the topic
  // pre-seeded. `from` is preserved purely for downstream attribution /
  // debugging — no UI behavior reads it today, but it lives in the URL
  // so the upcoming room ever needs to know "which shared report
  // converted you", we don't have to refactor the wire format.
  const [searchParams] = useSearchParams();
  const initialTopic = searchParams.get('topic') ?? '';
  const creatorToken = searchParams.get('creator') ?? '';
  const authorizedCode = searchParams.get('code') ?? '';
  const [templateId, setTemplateId] = useState<string>('blank');
  const [topic, setTopic] = useState(initialTopic);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const template = templateById(templateId);

  function pickTemplate(id: string) {
    setTemplateId(id);
    const t = templateById(id);
    // Only autofill the topic if the user hasn't typed something yet — picking
    // a different template after typing shouldn't clobber their work.
    if (t && !topic.trim()) setTopic(t.topicSeed);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!topic.trim() || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      if (!creatorToken || !authorizedCode) throw new Error('A signed creator link is required.');
      const code = authorizedCode;
      const created = await createHostedBrowserRoom(creatorToken, { code, topic: topic.trim(), name: name.trim(), role: role.trim(), color: colorForName(name.trim()), initials: initialsFor(name.trim()) });
      persistHumanSeat(code, { name: name.trim(), role: 'human', token: created.token });
      // Stash the chosen template so Lobby (and the room itself) can post the
      // opening message + show suggested roles. We use sessionStorage and not
      // a route param so re-opens or refreshes don't re-trigger the opener.
      if (template && template.id !== 'blank') {
        sessionStorage.setItem(`${TEMPLATE_KEY}${code}`, template.id);
      }
      navigate(`/r/${code}/lobby`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bg-white px-6 py-5">
        <div className="mx-auto max-w-6xl">
          <Link to="/" aria-label="Agent Room home" className="inline-block hover:opacity-85 transition">
            <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-base" />
          </Link>
        </div>
      </div>
      <form onSubmit={submit} className="max-w-2xl mx-auto mt-8 p-8 bg-surface border border-border rounded-xl shadow-card">
      <h1 className="text-lg font-semibold tracking-tight">New meeting</h1>
      <p className="text-xs text-ink-soft mt-1 mb-6">Pick a room shape, then a topic.</p>

      {error && <div className="text-[11px] text-red-600 mb-3">{error}</div>}

      <div className="mb-6">
        <span className="text-xs font-semibold text-ink-muted block mb-2">Template</span>
        <div className="grid sm:grid-cols-2 gap-2">
          {ROOM_TEMPLATES.map(t => {
            const active = t.id === templateId;
            return (
              <button
                type="button"
                key={t.id}
                onClick={() => pickTemplate(t.id)}
                className={`text-left rounded-lg border px-3 py-2.5 transition ${
                  active
                    ? 'border-accent bg-accent-tint ring-2 ring-accent/20'
                    : 'border-border bg-white hover:border-accent/40'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="text-base leading-none">{t.emoji}</span>
                  <span>{t.label}</span>
                </div>
                <div className="text-[11px] text-ink-soft leading-snug mt-1">{t.description}</div>
                {t.suggestedRoleIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.suggestedRoleIds.map(rid => (
                      <span key={rid} className="text-[9px] font-semibold text-accent bg-white border border-accent-tint-border px-1.5 py-px rounded">
                        {roleLabelFor(rid)}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block mb-4">
        <span className="text-xs font-semibold text-ink-muted block mb-1.5">Topic</span>
        <input value={topic} onChange={e => setTopic(e.target.value)} required
          placeholder={template?.topicSeed || 'What are we discussing?'}
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
        {template && template.id !== 'blank' && (
          <span className="text-[10px] text-ink-faint mt-1 block">
            Tip: replace <code className="bg-surface-softer px-1 rounded text-[10px]">{'{...}'}</code> placeholders with the real subject.
          </span>
        )}
      </label>
      <label className="block mb-4">
        <span className="text-xs font-semibold text-ink-muted block mb-1.5">Your name</span>
        <input value={name} onChange={e => setName(e.target.value)} required
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
      </label>
      <label className="block mb-6">
        <span className="text-xs font-semibold text-ink-muted block mb-1.5">Your role <span className="text-ink-faint font-medium">optional</span></span>
        <select
          value={ROLE_PRESETS.some(p => p.role === role) ? role : ''}
          onChange={e => setRole(e.target.value)}
          className="w-full mb-2 px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint"
        >
          <option value="">Custom role</option>
          {ROLE_PRESETS.map(p => <option key={p.id} value={p.role}>{p.label}</option>)}
        </select>
        <input value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. Frontend"
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg outline-none text-sm focus:border-accent focus:ring-4 focus:ring-accent-tint" />
      </label>

      <button disabled={busy} type="submit" className="w-full bg-accent text-white py-2.5 rounded-lg font-semibold text-sm disabled:opacity-50">
        {busy ? 'Creating…' : 'Create meeting →'}
      </button>
      </form>
    </>
  );
}
