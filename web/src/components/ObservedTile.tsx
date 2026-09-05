import type { ObservedSession, TranscriptItem } from '@claudia/shared';
import type { MirrorView } from '../mirror-state';
import { fmtDur } from '../format';
import { send } from '../store';
import { COLORS } from '../status';

/**
 * A session running in a terminal, which Claudia can see but not touch.
 *
 * Deliberately looks unlike a real tile. Everything else on this board has
 * buttons; this has none, and there is no honest way to add them — there is no
 * attach path to a live CLI, so approving or interrupting from here is not
 * something that could be built later. The dashed border and the muted palette
 * are the promise that clicking will not do anything.
 *
 * It can now be EXPANDED to read the conversation, which is a stronger promise
 * to keep rather than a weaker one: the expanded view looks more like an owned
 * session than the collapsed tile does, so it says READ-ONLY in the header and
 * has no composer. A mirror that looked like a session and silently discarded
 * what you typed would be worse than the thin tile it replaced.
 *
 * There is no thinking view, and that is not an omission. Every thinking block
 * in a real transcript carries a signature and an EMPTY body — the reasoning is
 * not retained in the log — so a panel for it would always be blank.
 */

const STATE_LABEL: Record<ObservedSession['state'], { text: string; color: string }> = {
  working: { text: 'working', color: COLORS.accent },
  idle: { text: 'idle', color: COLORS.ok },
  needs_you: { text: 'needs you', color: COLORS.warn },
  ended: { text: 'ended', color: '#5a5e70' },
};

/** What the notification actually meant, in words rather than an enum. */
const NEEDS_LABEL: Record<string, string> = {
  permission_prompt: 'waiting on a permission prompt',
  idle_prompt: 'waiting for your input',
  agent_needs_input: 'an agent needs input',
};

const name = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

export function ObservedTile({
  session,
  now,
  mirror,
  open,
  onToggle,
}: {
  session: ObservedSession;
  now: number;
  mirror?: MirrorView;
  open?: boolean;
  onToggle?: () => void;
}) {
  const mark = STATE_LABEL[session.state];
  const quiet = now - session.lastEventAt;
  const detail =
    (session.needs ? (NEEDS_LABEL[session.needs] ?? session.needs) : undefined) ??
    (session.state === 'working' && session.lastTool ? `running ${session.lastTool}` : undefined) ??
    session.lastMessage ??
    session.lastPrompt;

  return (
    <section
      style={{
        border: '1px dashed #3a3d52',
        borderRadius: 10,
        padding: '10px 12px',
        background: '#191b26',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        opacity: session.state === 'ended' ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span
          title={session.cwd}
          style={{
            fontSize: 12.5,
            color: '#cfd3e5',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name(session.cwd)}
        </span>
        <span
          title="Seen through Claude Code's hooks — Claudia did not launch this one and cannot control it"
          style={{
            flex: 'none',
            fontSize: 9,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: '#75798c',
            border: '1px solid #33364a',
            borderRadius: 4,
            padding: '1px 4px',
          }}
        >
          terminal
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ flex: 'none', fontSize: 10.5, color: mark.color }}>{mark.text}</span>
        {onToggle && (
          <button
            onClick={() => {
              send(open ? { type: 'close_mirror', sessionId: session.id } : { type: 'mirror_session', sessionId: session.id });
              onToggle();
            }}
            title={open ? 'Stop reading this transcript' : "Read this session's transcript — you still cannot type into it"}
            className="btn btn-ghost"
            style={{ flex: 'none', fontSize: 10, padding: '1px 6px' }}
          >
            {open ? 'hide' : 'read'}
          </button>
        )}
      </div>

      {detail && (
        <div
          style={{
            fontSize: 11,
            color: '#9397ab',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={detail}
        >
          {detail}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#595d6c' }}>
        {session.permissionMode && <span>{session.permissionMode}</span>}
        {/* Staleness is load-bearing on a read-only tile: a terminal killed with
            Ctrl+C sends nothing, so "last seen" is the only honest signal that
            what you are reading may already be over. */}
        <span title={new Date(session.lastEventAt).toLocaleString()}>
          {quiet < 5000 ? 'just now' : `${fmtDur(quiet)} ago`}
        </span>
      </div>

      {open && <Mirror mirror={mirror} />}
    </section>
  );
}

/**
 * The conversation, as far as the log has it.
 *
 * Read-only is stated rather than implied. The collapsed tile can rely on
 * having no controls at all; this one shows a feed that looks like a session's,
 * so it says what it is.
 */
function Mirror({ mirror }: { mirror?: MirrorView }) {
  if (!mirror) return <Note>reading…</Note>;
  if (mirror.reason) return <Note>{mirror.reason}</Note>;
  if (mirror.transcript.length === 0) return <Note>nothing in this transcript yet</Note>;

  return (
    <div style={{ borderTop: '1px dashed #33364a', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 9, letterSpacing: 0.4, textTransform: 'uppercase', color: '#75798c' }}>
          read-only
        </span>
        {mirror.elided > 0 && (
          <span style={{ fontSize: 10, color: '#595d6c' }}>{mirror.elided} earlier steps not shown</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
        {mirror.transcript.map((item, index) => (
          <div key={`${item.ts}-${index}`} style={{ fontSize: 11, lineHeight: 1.45, minWidth: 0 }}>
            <span style={{ color: KIND_COLOR[item.kind] ?? '#9397ab', marginRight: 6 }}>{KIND_LABEL[item.kind]}</span>
            <span style={{ color: '#c3c7d9', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {item.toolName ? `${item.toolName} ` : ''}
              {clamp(item.text)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<TranscriptItem['kind'], string> = {
  user: 'you',
  assistant: 'claude',
  thinking: 'thinking',
  tool_use: 'tool',
  tool_result: '→',
};

const KIND_COLOR: Record<string, string> = {
  user: '#8fa6d8',
  assistant: COLORS.ok,
  tool_use: '#b08cd8',
  tool_result: '#75798c',
};

/** Long tool output is the bulk of a transcript and the least of what a reader wants. */
const clamp = (text: string): string => (text.length > 600 ? `${text.slice(0, 599)}…` : text);

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ borderTop: '1px dashed #33364a', paddingTop: 8, fontSize: 11, color: '#75798c' }}>{children}</div>
  );
}
