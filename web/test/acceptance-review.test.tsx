import type { Task } from '@claudia/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AcceptanceReview, summary } from '../src/components/AcceptanceReview';

const task: Task = {
  id: 't1', missionId: 'm1', title: 'Ship it', description: '', cwd: '/repo', status: 'reported',
  priority: 0, dependsOn: [], acceptance: 'All keyboard paths work.', createdAt: 1, updatedAt: 1,
};

describe('acceptance review summary', () => {
  it('distinguishes waiting, rejected, incomplete, and decision-ready claims', () => {
    expect(summary(undefined)).toBe('Checking completion claim');
    expect(summary({ verdict: 'reject', reason: 'tests failed', missing: [] })).toBe('Evidence needs work');
    expect(summary({ verdict: 'needs_human', reason: '', missing: ['tests'] })).toBe('1 evidence gap');
    expect(summary({ verdict: 'needs_human', reason: '', missing: ['tests', 'branch'] })).toBe('2 evidence gaps');
    expect(summary({ verdict: 'needs_human', reason: 'green', missing: [] })).toBe('Ready for your decision');
  });
});

describe('acceptance review evidence', () => {
  it('renders criteria, gaps, and only the reasoned override path for incomplete evidence', () => {
    const html = renderToStaticMarkup(<AcceptanceReview
      missionId="m1"
      task={task}
      judgement={{ verdict: 'needs_human', reason: 'no tests', missing: ['test results'], unreadTests: 1 }}
    />);
    expect(html).toContain('All keyboard paths work.');
    expect(html).toContain('Missing: test results.');
    expect(html).toContain('1 test result');
    expect(html).not.toContain('None recorded');
    expect(html).toContain('accept with override');
    expect(html).not.toContain('accept task');
  });

  it('offers plain acceptance when the evidence is complete', () => {
    const html = renderToStaticMarkup(<AcceptanceReview
      missionId="m1"
      task={task}
      judgement={{ verdict: 'needs_human', reason: 'green', missing: [], tests: [{ command: 'npm test', exitCode: 0 }] }}
    />);
    expect(html).toContain('passed');
    expect(html).toContain('npm test');
    expect(html).toContain('accept task');
    expect(html).not.toContain('accept with override');
  });

  it('shows PR state even when no safe link is available', () => {
    const html = renderToStaticMarkup(<AcceptanceReview
      missionId="m1"
      task={task}
      judgement={{ verdict: 'needs_human', reason: 'green', missing: [], prState: 'merged' }}
    />);
    expect(html).toContain('Pull request:');
    expect(html).toContain('merged');
  });
});
