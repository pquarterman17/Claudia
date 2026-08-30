import type { SessionSummary, ToolkitAction } from '@claudia/shared';
import { send } from '../store';

/**
 * Saved prompts, fired at a session that is already running.
 *
 * Templates only ever LAUNCH a session; the repetitive typing is into sessions
 * already open — run the tests, summarise the diff, review this. This is that
 * half.
 *
 * Deliberately a plain list of text buttons rather than a grid of icons. The
 * board's job is to stay scannable across many tiles at once; a wall of
 * decorated buttons competes with the sessions for attention, and an emoji is
 * a worse label than the verb it replaces.
 */

interface Props {
  /** The session an action will be sent to, or undefined when ambiguous. */
  target: SessionSummary | undefined;
  actions: ToolkitAction[];
}

export function ToolkitPanel({ target, actions }: Props) {
  // A directory-scoped action is noise outside the directory it belongs to.
  const visible = actions.filter((a) => !a.cwd || a.cwd === target?.cwd);

  const add = () => {
    const name = window.prompt('Action name (e.g. "Run & fix tests")')?.trim();
    if (!name) return;
    const prompt = window.prompt(`What should Claude do when you pick "${name}"?`)?.trim();
    if (!prompt) return;
    const scoped =
      target && window.confirm(`Limit "${name}" to ${target.cwd}?\n\nCancel keeps it available everywhere.`);
    send({
      type: 'save_toolkit_action',
      action: {
        id: `t-${Date.now().toString(36)}`,
        name,
        prompt,
        ...(scoped && target ? { cwd: target.cwd } : {}),
      },
    });
  };

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="kicker">Toolkit</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-ghost"
          title="Save a new prompt you can fire at a running session"
          onClick={add}
          style={{ fontSize: 10, minHeight: 28, padding: '1px 6px', color: '#75798c' }}
        >
          + add
        </button>
      </div>

      {!target && (
        <div style={{ fontSize: 10.5, color: '#595d6c' }}>
          Focus a session (click it, or {'⌘'}1–9) to send an action to it.
        </div>
      )}

      {target && visible.length === 0 && (
        <div style={{ fontSize: 10.5, color: '#595d6c' }}>No actions yet — add one above.</div>
      )}

      {target && visible.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: '#595d6c', marginBottom: 5 }}>
            sends to <span style={{ color: '#9397ab' }}>{target.title ?? target.name}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {visible.map((action) => (
              <div key={action.id} style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  title={action.prompt}
                  onClick={() => send({ type: 'send_prompt', sessionId: target.id, text: action.prompt })}
                  style={{
                    flex: 1,
                    minHeight: 28,
                    padding: '3px 8px',
                    fontSize: 11,
                    textAlign: 'left',
                    color: '#cfd3e5',
                    border: '1px solid #33364a',
                    borderRadius: 6,
                  }}
                >
                  {action.name}
                  {action.cwd && (
                    <span style={{ fontSize: 9, color: '#595d6c', marginLeft: 5 }}>scoped</span>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Delete ${action.name}`}
                  title={`Delete "${action.name}"`}
                  onClick={() => {
                    if (window.confirm(`Delete the "${action.name}" action?`)) {
                      send({ type: 'delete_toolkit_action', id: action.id });
                    }
                  }}
                  style={{ minHeight: 28, padding: '1px 6px', fontSize: 10, color: '#595d6c' }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
