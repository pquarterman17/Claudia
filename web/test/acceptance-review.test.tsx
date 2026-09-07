import type { Task } from '@claudia/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AcceptanceReview, acceptCommand, summary } from '../src/components/AcceptanceReview';
import { evidenceSupportsAcceptance } from '../src/judged';

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

  it('does not promise a decision the panel below it will refuse', () => {
    // `evidenceSupportsAcceptance` fails closed on unread results, so a
    // headline that ignored them said "Ready for your decision" over a panel
    // offering only the override — and the headline is the only text a
    // reviewer who does not expand the disclosure ever reads.
    const unread = { verdict: 'needs_human' as const, reason: 'green', missing: [], unreadTests: 1 };
    expect(summary(unread)).toBe('Evidence could not be read');
    expect(evidenceSupportsAcceptance(unread)).toBe(false);
  });
});

describe('the command each path sends', () => {
  it('omits the override entirely unless a reason was written', () => {
    // The difference between the two buttons, and nothing rendered to HTML
    // shows it. An empty override on the plain path would record a decision
    // as having been argued for when nobody argued anything.
    expect(acceptCommand('m1', 't1')).toEqual({ type: 'accept_task', missionId: 'm1', taskId: 't1' });
    expect(acceptCommand('m1', 't1', '   ')).toEqual({ type: 'accept_task', missionId: 'm1', taskId: 't1' });
    expect(acceptCommand('m1', 't1', 'the check itself is wrong')).toEqual({
      type: 'accept_task', missionId: 'm1', taskId: 't1', override: 'the check itself is wrong',
    });
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

  it('will not report silence about risks it could not read', () => {
    const html = renderToStaticMarkup(<AcceptanceReview
      missionId="m1"
      task={task}
      judgement={{ verdict: 'needs_human', reason: 'green', missing: [], risks: [], unreadRisks: 1 }}
    />);
    // Scoped to the risks line: artifacts legitimately say "None reported"
    // here, because nothing was reported and nothing failed to be read.
    const risks = html.slice(html.indexOf('Risks'));
    expect(risks).toContain('1 could not be read');
    expect(risks).not.toContain('None reported');
  });

  it('gives a failed ancestry check the weight of the rejection it is', () => {
    const html = renderToStaticMarkup(<AcceptanceReview
      missionId="m1"
      task={task}
      judgement={{ verdict: 'reject', reason: 'not on its base', missing: [], descendsFromBase: false }}
    />);
    // The colour every other failure in the panel uses, on the fact itself —
    // asserted as the pairing, since the rejected verdict tints its own line
    // the same colour and a bare search for it would pass either way.
    expect(html).toContain('<span style="color:#e07070">Does not descend from base</span>');
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
