import type { SessionSummary, SlashCommandInfo } from '@claudia/shared';
import { useRef, useState } from 'react';
import { fmtCost, fmtTokens } from '../format';
import { PromptHistory } from '../prompt-history';
import { send, useClaudia } from '../store';
import { COLORS, statusOf } from '../status';
import { ImageStrip, MAX_IMAGES, readImageFiles, type PendingImage } from './ImageStrip';
import { ReasoningControls } from './ReasoningControls';

interface Props {
  session: SessionSummary;
}

/** One recall history per session, kept outside React state so remounts (and
 * re-renders) never lose it — it must survive exactly as long as the session does. */
const histories = new Map<string, PromptHistory>();
function historyFor(sessionId: string): PromptHistory {
  let history = histories.get(sessionId);
  if (!history) {
    history = new PromptHistory();
    histories.set(sessionId, history);
  }
  return history;
}

/** startsWith matches rank above includes matches; capped at 8 for a dropdown, not a page. */
function matchCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const q = query.toLowerCase();
  const starts: SlashCommandInfo[] = [];
  const contains: SlashCommandInfo[] = [];
  for (const c of commands) {
    const lower = c.name.toLowerCase();
    if (lower.startsWith(q)) starts.push(c);
    else if (lower.includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, 8);
}

/**
 * The session's prompt row: skip-perms toggle, the input itself (with shell-style
 * history recall and slash-command completion), queued/token/cost chips, a
 * fresh-session shortcut, and a model picker.
 */
export function Composer({ session }: Props) {
  const { models, commands } = useClaudia();
  const [draft, setDraft] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Whether Up/Down is currently walking history, and what to restore past the newest entry. */
  const recalling = useRef(false);
  const preRecallDraft = useRef('');
  /** Fetch the structured command list (descriptions, argument hints) once we
   * know the user wants it, rather than on every session — most tiles never
   * open the composer's slash autocomplete. */
  const requestedCommands = useRef(false);

  const status = statusOf(session.state);
  const yolo = session.permissionMode === 'bypassPermissions';
  const isCodex = session.agent === 'codex';

  const submit = () => {
    const text = draft.trim();
    if (!text && images.length === 0) return;
    send({ type: 'send_prompt', sessionId: session.id, text, images: images.map(({ preview: _preview, id: _id, ...image }) => image) });
    if (text) historyFor(session.id).push(text);
    recalling.current = false;
    setDraft('');
    setImages([]);
  };

  const addFiles = async (files: FileList | File[]) => {
    const loaded = await readImageFiles(files, images.length);
    if (loaded.length > 0) setImages((current) => [...current, ...loaded].slice(0, MAX_IMAGES));
  };

  const recallPrev = () => {
    const history = historyFor(session.id);
    if (!recalling.current) {
      recalling.current = true;
      preRecallDraft.current = draft;
    }
    const result = history.prev(draft);
    if (result !== null) setDraft(result);
  };

  const recallNext = () => {
    if (!recalling.current) return;
    const result = historyFor(session.id).next();
    if (result === null) {
      recalling.current = false;
      setDraft(preRecallDraft.current);
    } else {
      setDraft(result);
    }
  };

  const commandQuery = draft.startsWith('/') ? draft.slice(1) : null;
  const commandMatches = commandQuery === null ? [] : matchCommands(commands[session.id] ?? [], commandQuery);

  /** First "/" in this tile: ask for the structured list (descriptions, argument
   * hints) via supportedCommands(). Until it resolves, matches still come from
   * whatever the init message already gave us — see the store's fallback guard. */
  const requestCommandsOnce = () => {
    if (requestedCommands.current) return;
    requestedCommands.current = true;
    send({ type: 'get_commands', sessionId: session.id });
  };

  const completeCommand = (name: string) => {
    recalling.current = false;
    setDraft(`/${name} `);
  };

  const modelChoices = models[session.id];
  const toggleModelPicker = () => {
    if (!modelOpen && modelChoices === undefined) send({ type: 'get_models', sessionId: session.id });
    setModelOpen((open) => !open);
  };

  return (
    <div className="composer">
      <button
        type="button"
        aria-pressed={yolo}
        aria-label="Skip permission prompts"
        title={
          yolo
            ? 'Permissions skipped — click to require approvals again'
            : 'Click to run this session without permission prompts'
        }
        onClick={() =>
          send({
            type: 'set_permission_mode',
            sessionId: session.id,
            mode: yolo ? 'default' : 'bypassPermissions',
          })
        }
        style={{
          flex: 'none',
          cursor: 'pointer',
          borderRadius: 5,
          padding: '1px 6px',
          fontFamily: 'var(--font-body)',
          fontSize: 9.5,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          border: `1px solid ${yolo ? '#5c3b3b' : '#33364a'}`,
          background: yolo ? '#2e2226' : 'transparent',
          color: yolo ? COLORS.err : '#595d6c',
        }}
      >
        {yolo ? 'Approvals off' : 'Skip approvals'}
      </button>
      <span className="mono" style={{ color: status.color, fontSize: 12 }}>
        ›
      </span>
      <div
        style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        <ImageStrip images={images} onRemove={(id) => setImages((current) => current.filter((c) => c.id !== id))} />
        <input
          aria-label="Session prompt"
          value={draft}
          placeholder={
            session.needsAction ? 'answer…' : session.state === 'idle' ? 'send a new task…' : 'queue a message…'
          }
          onChange={(e) => {
            recalling.current = false;
            const next = e.target.value;
            setDraft(next);
            if (next.startsWith('/')) requestCommandsOnce();
          }}
          onPaste={(e) => {
            const files = e.clipboardData.files;
            if (Array.from(files).some((file) => file.type.startsWith('image/'))) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
              return;
            }
            if (e.key === 'Tab' && commandMatches.length > 0) {
              e.preventDefault();
              completeCommand(commandMatches[0]!.name);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              recallPrev();
              return;
            }
            if (e.key === 'ArrowDown' && recalling.current) {
              e.preventDefault();
              recallNext();
            }
          }}
        />
        {commandMatches.length > 0 && (
          <div
            className="mono"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              zIndex: 5,
              minWidth: 180,
              maxWidth: 320,
              background: '#1d1f2c',
              border: '1px solid #33364a',
              borderRadius: 6,
              boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)',
              overflow: 'hidden',
            }}
          >
            {commandMatches.map((c) => (
              <div
                key={c.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  completeCommand(c.name);
                }}
                style={{ padding: '4px 9px', fontSize: 11, cursor: 'pointer', color: '#cfd3e5' }}
              >
                <div>
                  /{c.name}
                  {c.argumentHint && <span style={{ color: '#75798c' }}> {c.argumentHint}</span>}
                </div>
                {c.description && (
                  <div
                    style={{
                      fontSize: 9.5,
                      color: '#75798c',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.description}
                  </div>
                )}
              </div>
            ))}
            <div
              style={{
                padding: '3px 9px',
                fontSize: 9,
                color: '#595d6c',
                borderTop: '1px solid #2c2f3d',
                fontFamily: 'var(--font-body)',
              }}
            >
              runs a slash command
            </div>
          </div>
        )}
      </div>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
      <button type="button" className="btn btn-ghost" title="Attach up to four PNG, JPEG, GIF, or WebP images (5 MB each); you can also paste or drop images" aria-label="Attach images" onClick={() => fileInput.current?.click()} style={{ flex: 'none', fontSize: 14, padding: '1px 5px', color: '#8d91a8' }}>
        +
      </button>
      {session.queuedPrompts.length > 0 && (
        <span
          title={session.queuedPrompts.join('\n')}
          style={{
            flex: 'none',
            fontSize: 10,
            color: '#d9b184',
            border: '1px solid #6b5636',
            borderRadius: 4,
            padding: '1px 6px',
          }}
        >
          {session.queuedPrompts.length} queued
        </span>
      )}
      <span
        title={isCodex ? 'Codex reports token counts only — no dollar cost' : undefined}
        style={{ flex: 'none', fontSize: 10, color: '#75798c', fontVariantNumeric: 'tabular-nums' }}
      >
        {fmtTokens(session.inputTokens + session.outputTokens)}
      </span>
      {!isCodex && (
        <span style={{ flex: 'none', fontSize: 10, color: '#b5abfc', fontVariantNumeric: 'tabular-nums' }}>
          {fmtCost(session.costUsd)}
        </span>
      )}
      <button
        className="btn btn-ghost"
        title="Start a fresh session beside this one, same folder and permissions"
        onClick={() => send({ type: 'launch_session', cwd: session.cwd, permissionMode: session.permissionMode })}
        style={{ flex: 'none', fontSize: 10, padding: '2px 6px', color: '#75798c' }}
      >
        New session
      </button>
      <span style={{ position: 'relative', flex: 'none' }}>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={isCodex}
          title={isCodex ? 'Codex has no model picker — its model is fixed at launch' : 'Pick the model for this session'}
          onClick={toggleModelPicker}
          style={{ fontSize: 10, padding: '2px 6px', color: '#75798c' }}
        >
          Choose model
        </button>
        {modelOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              right: 0,
              marginBottom: 4,
              zIndex: 5,
              minWidth: 210,
              maxHeight: 240,
              overflowY: 'auto',
              background: '#1d1f2c',
              border: '1px solid #33364a',
              borderRadius: 6,
              boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)',
            }}
          >
            {modelChoices === undefined && (
              <div style={{ padding: '6px 9px', fontSize: 10.5, color: '#75798c' }}>loading…</div>
            )}
            {modelChoices?.length === 0 && (
              <div style={{ padding: '6px 9px', fontSize: 10.5, color: '#75798c' }}>no models reported</div>
            )}
            {modelChoices?.map((m) => {
              // Marks the pick the moment it is made. Without this the menu
              // looked inert, because a switch does not reach the chip until
              // the next turn reports which model actually ran.
              const chosen = session.selectedModel === m.value;
              return (
                <div
                  key={m.value}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    send({ type: 'set_model', sessionId: session.id, model: m.value });
                    setModelOpen(false);
                  }}
                  style={{
                    padding: '5px 9px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #26293a',
                    background: chosen ? '#2b2741' : 'transparent',
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: chosen ? '#d2cefd' : '#e4e7f5' }}>
                    {chosen ? '✓ ' : ''}
                    {m.displayName}
                    {chosen && <span style={{ color: COLORS.warn, fontWeight: 400 }}> · next turn</span>}
                  </div>
                  {m.description && <div style={{ fontSize: 9.5, color: '#75798c' }}>{m.description}</div>}
                </div>
              );
            })}
          </div>
        )}
      </span>
      <ReasoningControls session={session} />
    </div>
  );
}
