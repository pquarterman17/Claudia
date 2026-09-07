import { useMemo, useState } from 'react';
import type { FleetEvent, Task, TaskStatus } from '@claudia/shared';
import { send } from '../store';
import { judgementFor } from '../judged';
import { HUMAN_MOVES, MOVE_LABEL } from '../task-moves';
import { AcceptanceReview } from './AcceptanceReview';

/**
 * One mission's tasks, and the decisions that are the human's to make.
 *
 * The mission layer has been able to do all of this since the pulse landed; it
 * simply had no way in. The one move that matters most here is
 * `proposed -> ready`: a task described is not an instruction to spend money,
 * and until somebody promotes it the reconciler will not dispatch it. That is
 * the whole reason a fleet that can start real children still waits.
 *
 * Which moves appear is `task-moves.ts`, not this file, and it is a subset of
 * the state machine on purpose — the fleet keeps the two edges it has to
 * observe for itself.
 */

const STATUS_COLOR: Readonly<Record<TaskStatus, string>> = {
  proposed: '#75798c',
  ready: '#8ab4ff',
  blocked: '#e0a34f',
  running: '#7ee0a3',
  reported: '#d2cefd',
  accepted: '#5fbf7f',
  failed: '#e07070',
  cancelled: '#595d6c',
};

export function MissionTasks({
  missionId,
  cwd,
  tasks,
  events,
  elided,
}: {
  missionId: string;
  cwd: string;
  tasks: Task[] | undefined;
  events: FleetEvent[] | undefined;
  /** History the client was not sent, or dropped off the front of its own cap. */
  elided: number;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');

  // Computed once per timeline, not once per keystroke, and in ONE pass over
  // the window rather than one per reported task. The inputs below are
  // controlled state on this component, so every character typed into any of
  // them re-renders the whole list; `judgementFor` walks the capped 200-event
  // window and re-parses every matching payload, including a `new URL` per PR
  // link, so calling it per task was that walk N times over.
  const judgements = useMemo(() => {
    const reported = new Set((tasks ?? []).filter((task) => task.status === 'reported').map((task) => task.id));
    const byTask = new Map<string, FleetEvent[]>();
    for (const event of events ?? []) {
      if (event.taskId === undefined || !reported.has(event.taskId)) continue;
      const bucket = byTask.get(event.taskId);
      if (bucket) bucket.push(event);
      else byTask.set(event.taskId, [event]);
    }
    const found = new Map<string, ReturnType<typeof judgementFor>>();
    const runOf = new Map((tasks ?? []).map((task) => [task.id, task.currentRunId]));
    for (const id of reported) found.set(id, judgementFor(byTask.get(id), id, runOf.get(id)));
    return found;
  }, [events, tasks]);

  const add = (): void => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    // The mission's directory unless a task says otherwise. A task in another
    // repository is a real thing to want, but it is not the common case and
    // making it the required case would put a path field in front of every
    // task somebody types.
    send({
      type: 'create_task',
      missionId,
      title: trimmed,
      description: description.trim(),
      cwd,
      ...(acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
    });
    setTitle('');
    setDescription('');
    setAcceptance('');
  };

  return (
    <div style={{ padding: '8px 0 4px 16px', borderLeft: '1px solid #23263a', marginLeft: 4 }}>
      {(tasks ?? []).length === 0 ? (
        <p style={{ fontSize: 11, color: '#595d6c', margin: '0 0 8px' }}>
          No tasks yet. Describe one below — it starts as <em>proposed</em>, and nothing is dispatched until you
          mark it ready.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: '0 0 8px', padding: 0, display: 'grid', gap: 6 }}>
          {(tasks ?? []).map((task) => (
            <li key={task.id}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    color: STATUS_COLOR[task.status],
                    minWidth: 62,
                  }}
                >
                  {task.status}
                </span>
                <span style={{ fontSize: 12, color: '#c8cadb', flex: 1, minWidth: 160 }}>{task.title}</span>
                {HUMAN_MOVES[task.status].map((to) => (
                  <button
                    key={to}
                    className="btn btn-ghost"
                    onClick={() => send({ type: 'set_task_status', missionId, taskId: task.id, status: to })}
                    style={{
                      fontSize: 10,
                      padding: '1px 7px',
                      border: `1px solid ${to === 'cancelled' ? '#4a3038' : '#33364a'}`,
                      borderRadius: 5,
                      color: to === 'cancelled' ? '#c08a8a' : '#a8abbd',
                      cursor: 'pointer',
                    }}
                  >
                    {MOVE_LABEL[to]}
                  </button>
                ))}
              </div>
              {task.status === 'reported' && (
                <AcceptanceReview missionId={missionId} task={task} judgement={judgements.get(task.id)} />
              )}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          placeholder="What should a child do?"
          style={field(220)}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          placeholder="Detail (optional)"
          style={field(240)}
        />
        {/* A textarea, because everything downstream is built for a block:
            `isText` permits newlines, `briefFor` sends the whole thing to the
            child under `## Done when`, and the review panel renders it
            `pre-wrap`. As a single-line input with Enter bound to `add`, a
            three-bullet definition of done created three tasks, the first
            holding one bullet. Enter is left alone here; the button submits. */}
        <textarea
          value={acceptance}
          onChange={(e) => setAcceptance(e.target.value)}
          rows={2}
          placeholder="Done when… (optional)"
          aria-label="Acceptance criteria"
          style={{ ...field(240), resize: 'vertical', fontFamily: 'inherit' }}
        />
        <button onClick={add} disabled={title.trim() === ''} className="btn btn-ghost" style={action}>
          add task
        </button>
      </div>

      {events !== undefined && events.length > 0 && (
        <details>
          <summary style={{ fontSize: 10.5, color: '#595d6c', cursor: 'pointer' }}>
            history — {events.length} event{events.length === 1 ? '' : 's'}
            {elided > 0 && <span style={{ color: '#e0a34f' }}> · {elided} earlier not shown</span>}
          </summary>
          <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 2 }}>
            {/* Newest first for reading, though the log itself is ordered by
                sequence: a timeline you scroll to the bottom of to see what
                just happened is a timeline nobody reads. */}
            {[...events].reverse().map((event) => (
              <li key={event.seq} style={{ fontSize: 10.5, color: '#75798c', fontFamily: 'ui-monospace, monospace' }}>
                <span style={{ color: '#4a4d5e' }}>{new Date(event.at).toLocaleTimeString()} </span>
                <span style={{ color: '#8ab4ff' }}>{event.actor}</span> {event.kind}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const field = (width: number): React.CSSProperties => ({
  flex: `1 1 ${width}px`,
  minWidth: 140,
  fontSize: 11.5,
  padding: '3px 7px',
  background: '#15172480',
  border: '1px solid #2a2d40',
  borderRadius: 5,
  color: '#c8cadb',
});

const action: React.CSSProperties = {
  fontSize: 10.5,
  padding: '3px 10px',
  border: '1px solid #33364a',
  borderRadius: 5,
  color: '#a8abbd',
  cursor: 'pointer',
};
