import { useMemo } from 'react';
import type { Escalation, FleetLimits, Mission, Task, TaskStatus } from '@claudia/shared';
import { missionFlow } from '../mission-flow';
import type { Spend } from './MissionBudget';

const LABEL: Readonly<Record<TaskStatus, string>> = {
  proposed: 'Proposed', ready: 'Ready', blocked: 'Blocked', running: 'Running',
  reported: 'Reported', accepted: 'Accepted', failed: 'Failed', cancelled: 'Cancelled',
};

/** The scan-first view: what is moving, what is held, and what needs a person. */
export function MissionFlow({ tasks, mission, spend, limits, escalations }: { tasks: Task[] | undefined; mission: Mission; spend: Spend | undefined; limits: FleetLimits; escalations: Escalation[] | undefined }) {
  const model = useMemo(() => missionFlow(tasks ?? [], mission, spend, limits, escalations ?? []), [tasks, mission, spend, limits, escalations]);
  if (model.tasks.length === 0) return null;

  return (
    <section className="mission-flow" aria-labelledby="mission-flow-heading">
      <div className="mission-flow-heading">
        <span id="mission-flow-heading" className="kicker">Flow</span>
        <span className="mission-flow-next"><span>Next</span> {model.next}</span>
      </div>
      <ul className="mission-flow-counts" aria-label="Task status totals">
        {([...model.counts] as [TaskStatus, number][]).map(([status, count]) => (
          <li key={status} data-status={status}><strong>{count}</strong> {LABEL[status]}</li>
        ))}
      </ul>
      <ol className="mission-flow-grid" aria-label="Task dependency flow">
        {model.tasks.map((task) => (
          <li key={task.id} className="mission-flow-task" data-status={task.status}>
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
    </section>
  );
}
