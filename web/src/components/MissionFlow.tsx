import { useMemo } from 'react';
import type { Escalation, FleetLimits, Mission, MissionSpendLike, Task, TaskStatus } from '@claudia/shared';
import { missionFlow } from '../mission-flow';
import { TASK_STATUS_COLOR } from '../task-status';

const LABEL: Readonly<Record<TaskStatus, string>> = {
  proposed: 'Proposed', ready: 'Ready', blocked: 'Blocked', running: 'Running',
  reported: 'Reported', accepted: 'Accepted', failed: 'Failed', cancelled: 'Cancelled',
};

/** The scan-first view: what is moving, what is held, and what needs a person. */
export function MissionFlow({ tasks, mission, spend, limits, escalations }: { tasks: Task[] | undefined; mission: Mission; spend: MissionSpendLike | undefined; limits: FleetLimits; escalations: Escalation[] | undefined }) {
  const model = useMemo(() => missionFlow(tasks ?? [], mission, spend, limits, escalations ?? []), [tasks, mission, spend, limits, escalations]);
  // Only an unloaded mission renders nothing. A mission with no tasks yet is a
  // real state with real advice — "Start watching to continue this mission" is
  // the most useful line in the app on a mission that has just been created,
  // and suppressing the whole section on `[]` was the one case that never
  // showed it.
  if (tasks === undefined) return null;
  // The detailed list immediately below already carries every terminal task.
  // Keep this scan-first view on work that can still change or need a person.
  const active = model.tasks.filter((task) => task.status !== 'accepted' && task.status !== 'cancelled');
  const terminal = model.tasks.length - active.length;

  return (
    <section className="mission-flow" aria-labelledby="mission-flow-heading">
      <div className="mission-flow-heading">
        <span id="mission-flow-heading" className="kicker">Flow</span>
        <span className="mission-flow-next"><span>Next</span> {model.next}</span>
      </div>
      {model.counts.size > 0 && (
      <ul className="mission-flow-counts" aria-label="Task status totals">
        {([...model.counts] as [TaskStatus, number][]).map(([status, count]) => (
          <li key={status} data-status={status} style={{ color: TASK_STATUS_COLOR[status] }}><strong>{count}</strong> {LABEL[status]}</li>
        ))}
      </ul>
      )}
      {active.length > 0 && (
      <ol className="mission-flow-grid" aria-label="Task dependency flow">
        {active.map((task) => (
          <li key={task.id} className="mission-flow-task" data-status={task.status} style={{ borderLeftColor: TASK_STATUS_COLOR[task.status] }}>
            <span className="mission-flow-status">{LABEL[task.status]}</span>
            <span className="mission-flow-title">{task.title}</span>
            {task.dependencies.length > 0 && (
              <span className="mission-flow-dependencies">
                <span aria-hidden="true">← </span>
                <span className="sr-only">Depends on </span>
                {task.dependencies.map((item) => `${item.title}${item.state === 'waiting' || item.state === 'satisfied' ? '' : ` (${item.state})`}`).join(', ')}
              </span>
            )}
          </li>
        ))}
      </ol>
      )}
      {terminal > 0 && <p className="mission-flow-terminal">{terminal} accepted or cancelled task{terminal === 1 ? '' : 's'} remain in the detailed list below</p>}
    </section>
  );
}
