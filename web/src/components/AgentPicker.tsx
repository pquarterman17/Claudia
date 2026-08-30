import type { SessionSummary } from '@claudia/shared';
import { useState } from 'react';
import { AGENT_KINDS } from '../agent-kinds';
import { send } from '../store';

/**
 * Which agent backs this tile, and the switch to change it.
 *
 * Per tile rather than per board: the launch bar's picker only decides what
 * the NEXT session starts as, which meant the choice had to be made before you
 * knew what the work needed. This is the same choice, available on the window
 * it applies to, at any time.
 *
 * Switching always starts a new conversation — Claude and Codex keep separate
 * stores and neither can resume the other's history — so a session that has
 * actually done something asks for a second, confirming click, in the same
 * shape the finish chain uses for its destructive steps. Nothing is lost
 * either way: the conversation left behind stays in this directory's resume
 * picker, which is what the caption says rather than a vaguer warning.
 */

/** Whether this session has a conversation worth warning about.
 *
 * Token counts rather than cost, because Codex reports tokens but never a
 * dollar cost — keying on cost would treat every finished Codex session as
 * untouched and switch it away silently. */
function hasConversation(session: SessionSummary): boolean {
  return (
    session.state !== 'idle' ||
    session.inputTokens > 0 ||
    session.outputTokens > 0 ||
    Boolean(session.claudeSessionId)
  );
}

export function AgentPicker({ session }: { session: SessionSummary }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const current = session.agent ?? 'claude';
  const isCodex = current === 'codex';
  const started = hasConversation(session);

  const choose = (key: string) => {
    if (key === current) {
      setOpen(false);
      return;
    }
    if (started && confirming !== key) {
      setConfirming(key);
      return;
    }
    send({ type: 'set_agent', sessionId: session.id, agent: key as 'claude' | 'codex' });
    setConfirming(null);
    setOpen(false);
  };

  return (
    <span style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setConfirming(null);
        }}
        title={
          isCodex
            ? 'Codex session — approvals and model choice work. No dollar cost, /context, MCP panel, effective-settings inspector, or file-checkpoint rewind. Click to change agent.'
            : 'Claude Code session. Click to change the agent for this window.'
        }
        style={{
          cursor: 'pointer',
          fontSize: 10,
          fontWeight: 600,
          // Codex keeps its distinct colour: a wrong assumption about which
          // agent a tile is running costs more than the click it saves.
          border: `1px solid ${isCodex ? '#3d5a80' : '#33364a'}`,
          background: isCodex ? '#1c2b3d' : 'transparent',
          borderRadius: 4,
          padding: '1px 6px',
          color: isCodex ? '#8ec1e8' : '#75798c',
        }}
      >
        {isCodex ? 'Codex' : 'Claude'}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            zIndex: 20,
            minWidth: 210,
            background: '#1a1c28',
            border: '1px solid #33364a',
            borderRadius: 7,
            padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          }}
        >
          {AGENT_KINDS.map((a) => {
            const isCurrent = a.key === current;
            const asking = confirming === a.key;
            return (
              <button
                key={a.key}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => choose(a.key)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '5px 7px',
                  border: 0,
                  borderRadius: 5,
                  background: asking ? '#2e2226' : 'transparent',
                  color: asking ? '#e0a0a0' : isCurrent ? '#d2cefd' : '#a4a8b8',
                  fontSize: 11.5,
                  cursor: isCurrent ? 'default' : 'pointer',
                }}
              >
                {isCurrent ? '✓ ' : ''}
                {asking ? `Switch to ${a.label} — click again` : a.label}
                {!isCurrent && (
                  <span style={{ display: 'block', fontSize: 10, color: asking ? '#c98d8d' : '#595d6c', marginTop: 2 }}>
                    {started
                      ? 'Starts a new conversation. This one stays in the resume picker.'
                      : 'This session has not started yet.'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
