import type { SubAgentRun } from '@claudia/shared';
import { fmtDur, fmtTokens } from '../format';
import { COLORS } from '../status';
import { send } from '../store';

const MARK: Record<SubAgentRun['status'], { icon: string; color: string }> = {
  running: { icon: '◇', color: COLORS.accent },
  completed: { icon: '◆', color: COLORS.ok },
  error: { icon: '✕', color: COLORS.err },
};

interface Props {
  runs: SubAgentRun[];
  sessionId: string;
}

/**
 * Sub-agents nested under the Task step that spawned them.
 *
 * Without this a Task is a single line that sits "running" for minutes with no
 * indication of what is happening or what it is spending. Tokens are shown
 * because the SDK reports them per sub-agent; cost is not, and is deliberately
 * not guessed at.
 */
export function SubAgentRows({ runs, sessionId }: Props) {
  if (runs.length === 0) return null;

  return (
    <div style={{ marginLeft: 25, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {runs.map((run) => {
        const mark = MARK[run.status];
        return (
          <div
            key={run.taskId}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 7,
              paddingLeft: 8,
              borderLeft: '1px solid #33364a',
            }}
          >
            <span
              style={{
                color: mark.color,
                fontSize: 10,
                marginTop: 1,
                animation: run.status === 'running' ? 'claudia-pulse 1.4s ease-in-out infinite' : 'none',
              }}
            >
              {mark.icon}
            </span>
            {run.status === 'running' && <button className="btn-ghost" title="Stop this observed background task" onClick={() => send({ type: 'stop_task', sessionId, taskId: run.taskId })}>Stop</button>}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 10, color: '#b5abfc' }}>{run.agentType}</span>
                {run.lastTool && run.status === 'running' && (
                  <span style={{ fontSize: 9.5, color: '#75798c' }}>via {run.lastTool}</span>
                )}
              </span>
              <span
                title={run.summary ?? run.description}
                style={{
                  display: 'block',
                  fontSize: 11,
                  color: run.status === 'error' ? COLORS.err : '#cfd3e5',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {run.status === 'completed' && run.summary
                  ? firstLine(run.summary)
                  : run.description || 'starting…'}
              </span>
            </span>
            <span
              title={`${run.toolUses} tool call${run.toolUses === 1 ? '' : 's'}`}
              style={{ fontSize: 9.5, color: '#75798c', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            >
              {fmtTokens(run.totalTokens)} · {fmtDur(run.durationMs)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Summaries are markdown paragraphs; the feed only has room for the gist. */
function firstLine(summary: string): string {
  const line = summary
    .split('\n')
    .map((l) => l.replace(/^[-*#>\s]+/, '').trim())
    .find((l) => l.length > 0);
  return line ? line.replace(/\*\*/g, '') : summary.slice(0, 80);
}
