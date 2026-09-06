import { useState } from 'react';
import type { Task } from '@claudia/shared';
import { evidenceSupportsAcceptance, type Judgement } from '../judged';
import { send } from '../store';

/** The evidence behind a child's completion claim, arranged for a decision. */
export function AcceptanceReview({ missionId, task, judgement }: {
  missionId: string;
  task: Task;
  judgement: Judgement | undefined;
}) {
  const [override, setOverride] = useState<string | undefined>();
  const supported = evidenceSupportsAcceptance(judgement);
  const tone = judgement?.verdict === 'reject' ? '#e07070' : supported ? '#7ee0a3' : '#e0a34f';

  return (
    <details style={panel}>
      <summary style={{ cursor: 'pointer', color: tone, fontSize: 11 }}>
        {summary(judgement)} <span style={{ color: '#75798c' }}>— review evidence</span>
      </summary>
      <div style={{ display: 'grid', gap: 10, paddingTop: 10 }}>
        <section aria-label="Acceptance criteria">
          <Label>Acceptance criteria</Label>
          <p style={copy}>{task.acceptance.trim() || 'No task-specific acceptance criteria were recorded.'}</p>
        </section>

        {!judgement ? (
          <p role="status" style={{ ...copy, color: '#75798c' }}>The server has not judged this completion claim yet.</p>
        ) : (
          <>
            <section aria-label="Decision summary">
              <Label>Decision</Label>
              <p style={{ ...copy, color: tone }}>{judgement.reason || 'No reason was recorded.'}</p>
              {judgement.missing.length > 0 && (
                <p style={{ ...copy, color: '#e0a34f' }}>Missing: {judgement.missing.join(', ')}.</p>
              )}
            </section>
            <Evidence judgement={judgement} />
          </>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {supported ? (
            <button className="btn btn-ghost" style={positive} onClick={() => send({ type: 'accept_task', missionId, taskId: task.id })}>
              accept task
            </button>
          ) : override === undefined ? (
            <button className="btn btn-ghost" style={warning} onClick={() => setOverride('')}>
              accept with override…
            </button>
          ) : (
            <>
              <label style={{ flex: '1 1 240px', fontSize: 10.5, color: '#a8abbd' }}>
                Override reason
                <input
                  autoFocus
                  value={override}
                  onChange={(event) => setOverride(event.target.value)}
                  placeholder="Explain why this evidence is sufficient"
                  style={field}
                />
              </label>
              <button
                className="btn btn-ghost"
                style={warning}
                disabled={override.trim() === ''}
                onClick={() => {
                  send({ type: 'accept_task', missionId, taskId: task.id, override });
                  setOverride(undefined);
                }}
              >
                record override and accept
              </button>
              <button className="btn btn-ghost" style={action} onClick={() => setOverride(undefined)}>cancel</button>
            </>
          )}
        </div>
      </div>
    </details>
  );
}

function Evidence({ judgement }: { judgement: Judgement }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
      <section aria-label="Change evidence">
        <Label>Change</Label>
        <Fact name="Branch" value={judgement.branch} mono />
        <Fact name="Files" value={judgement.filesChanged === undefined ? undefined : String(judgement.filesChanged)} />
        <Fact name="Head" value={shortSha(judgement.headSha)} mono />
        <Fact name="Base" value={shortSha(judgement.baseSha)} mono />
        <Fact name="Ancestry" value={judgement.descendsFromBase === undefined ? undefined : judgement.descendsFromBase ? 'Verified' : 'Does not descend from base'} />
      </section>
      <section aria-label="Test evidence">
        <Label>Checks</Label>
        {judgement.tests?.length ? judgement.tests.map((test, index) => (
          <div key={`${test.command}-${index}`} style={{ marginBottom: 5 }}>
            <span style={{ color: test.exitCode === 0 ? '#7ee0a3' : '#e07070', fontSize: 10.5 }}>
              {test.exitCode === 0 ? 'passed' : `failed (${test.exitCode})`}
            </span>{' '}
            <code style={{ fontSize: 10.5, color: '#c8cadb' }}>{test.command}</code>
            {test.summary && <div style={{ ...copy, color: '#75798c' }}>{test.summary}</div>}
          </div>
        )) : <Missing>None recorded</Missing>}
        {judgement.checks && <p style={{ ...copy, color: '#75798c' }}>{judgement.checks}</p>}
      </section>
      <section aria-label="Delivery evidence">
        <Label>Delivery</Label>
        {judgement.prUrl ? (
          <a href={judgement.prUrl} target="_blank" rel="noreferrer" style={{ color: '#8ab4ff', fontSize: 10.5 }}>
            Pull request{judgement.prState ? ` — ${judgement.prState}` : ''}
          </a>
        ) : <Missing>No pull request recorded</Missing>}
        <List label="Artifacts" values={judgement.artifacts} empty="None reported" />
        <List label="Risks" values={judgement.risks} empty="None reported" risk />
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#75798c', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{children}</div>;
}

function Fact({ name, value, mono = false }: { name: string; value: string | undefined; mono?: boolean }) {
  return <div style={copy}><span style={{ color: '#75798c' }}>{name}: </span><span style={{ fontFamily: mono ? 'ui-monospace, monospace' : undefined }}>{value ?? 'not recorded'}</span></div>;
}

function List({ label, values, empty, risk = false }: { label: string; values: string[] | undefined; empty: string; risk?: boolean }) {
  return (
    <div style={{ marginTop: 7 }}>
      <span style={{ ...copy, color: '#75798c' }}>{label}: </span>
      <span style={{ ...copy, color: risk && values?.length ? '#e0a34f' : '#c8cadb' }}>{values?.length ? values.join(' · ') : empty}</span>
    </div>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <div style={{ ...copy, color: '#75798c' }}>{children}</div>;
}

export function summary(judgement: Judgement | undefined): string {
  if (!judgement) return 'Checking completion claim';
  if (judgement.verdict === 'reject') return 'Evidence needs work';
  if (judgement.missing.length > 0) return `${judgement.missing.length} evidence gap${judgement.missing.length === 1 ? '' : 's'}`;
  return 'Ready for your decision';
}

function shortSha(sha: string | undefined): string | undefined {
  return sha?.slice(0, 8);
}

const panel: React.CSSProperties = { flexBasis: '100%', marginLeft: 70, padding: '6px 8px', background: '#15172480', borderLeft: '2px solid #33364a' };
const copy: React.CSSProperties = { margin: 0, fontSize: 10.5, color: '#c8cadb', lineHeight: 1.45 };
const action: React.CSSProperties = { fontSize: 10.5, padding: '3px 10px', border: '1px solid #33364a', borderRadius: 5, color: '#a8abbd', cursor: 'pointer' };
const positive: React.CSSProperties = { ...action, color: '#7ee0a3', borderColor: '#2f5a44' };
const warning: React.CSSProperties = { ...action, color: '#e0a34f', borderColor: '#5a4a2f' };
const field: React.CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 3, fontSize: 11.5, padding: '4px 7px', background: '#11131e', border: '1px solid #5a4a2f', borderRadius: 5, color: '#c8cadb' };
