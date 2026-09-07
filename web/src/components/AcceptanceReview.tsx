import { useState } from 'react';
import type { ClientCommand, Task } from '@claudia/shared';
import { evidenceSupportsAcceptance, type Judgement } from '../judged';
import { send } from '../store';

/**
 * The evidence behind a child's completion claim, arranged for a decision.
 *
 * These facts are observed by the server from git, the configured verification
 * command, and the forge. They are not the child's prose account of itself;
 * risks and artifacts are explicitly labeled self-reported exceptions. That
 * trust boundary is why `reported` remains a claim and `accepted` a separate
 * human decision.
 *
 * An override is an audit path, not a shortcut. Missing or failing evidence
 * can describe good work when a check itself is wrong, but accepting it costs
 * a reason that the server records beside the decision.
 */
export function AcceptanceReview({ missionId, task, judgement }: {
  missionId: string;
  task: Task;
  judgement: Judgement | undefined;
}) {
  const [override, setOverride] = useState<string | undefined>();
  // A reason already being typed keeps the override open even if a fresh
  // verdict would otherwise offer the plain button. `accept.ts` spends a long
  // comment on the reason being the whole point of an override, and tearing
  // the input down under somebody mid-sentence — a pulse re-judged, a page of
  // history landed — loses it silently and unsent.
  const writing = override !== undefined && override.trim() !== '';
  const supported = evidenceSupportsAcceptance(judgement) && !writing;
  const tone = judgement?.verdict === 'reject' ? '#e07070' : supported ? '#7ee0a3' : '#e0a34f';

  // The reason survives the send. `send` is fire-and-forget over a socket and
  // the refusal comes back as a notice — a task no longer `reported`, a store
  // write that lost a race — by which time a cleared input has already made
  // the reviewer retype from memory. That friction is what trains people to
  // write "ok" instead of a reason. The panel stops rendering once the task
  // leaves `reported`, so a successful accept clears it anyway.
  const accept = (reason: string): void => {
    send(acceptCommand(missionId, task.id, reason));
  };

  return (
    // Acceptance deliberately lives inside the disclosure: opening the
    // evidence is the small, explicit act that separates review from a click.
    <details style={panel}>
      <summary style={{ cursor: 'pointer', color: tone, fontSize: 11 }}>
        {summary(judgement, writing)} <span style={{ color: '#75798c' }}>— review evidence</span>
      </summary>
      <div style={{ display: 'grid', gap: 10, paddingTop: 10 }}>
        <section aria-label="Acceptance criteria">
          <Label>Acceptance criteria</Label>
          {/* Multi-line by design: `isText` permits newlines and `briefFor`
              hands the whole thing to the child as a `## Done when` block, so
              a three-bullet definition of done is ordinary input — and this is
              the one place a human checks the evidence against it. */}
          <p style={{ ...copy, whiteSpace: 'pre-wrap' }}>{task.acceptance?.trim() || 'No task-specific acceptance criteria were recorded.'}</p>
        </section>

        {!judgement ? (
          <p role="status" style={{ ...copy, color: '#75798c' }}>No judgement for this claim has reached the board yet.</p>
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
          {/* The reason input, once open, outranks whether the evidence
              supports a plain accept. It has to: the server can refuse an
              accept this panel offered — the fallback asymmetry `accept.ts`
              documents — and if the only way to reach this input were the
              unsupported branch, a task in that state could not be accepted at
              all. There was no route from "refused" back to "give a reason". */}
          {override !== undefined ? (
            <>
              <label style={{ flex: '1 1 240px', fontSize: 10.5, color: '#a8abbd' }}>
                Override reason
                <input
                  autoFocus
                  value={override}
                  onChange={(event) => setOverride(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter submits, as it does in all three task inputs next
                    // door. This one sits in a `div` rather than a `form`, so
                    // without a handler there is no implicit submit and the
                    // reason can only be committed with the mouse.
                    if (event.key === 'Enter' && override.trim() !== '') accept(override);
                  }}
                  placeholder="Explain why this evidence is sufficient"
                  style={field}
                />
              </label>
              <button
                className="btn btn-ghost"
                style={warning}
                disabled={override.trim() === ''}
                onClick={() => accept(override)}
              >
                record override and accept
              </button>
              <button className="btn btn-ghost" style={action} onClick={() => setOverride(undefined)}>cancel</button>
            </>
          ) : supported ? (
            <>
              <button className="btn btn-ghost" style={positive} onClick={() => send(acceptCommand(missionId, task.id))}>
                accept task
              </button>
              <button
                className="btn btn-ghost"
                style={action}
                title="Record why you are accepting, even though the evidence does not require it."
                onClick={() => setOverride('')}
              >
                with a reason…
              </button>
            </>
          ) : (
            <button className="btn btn-ghost" style={warning} onClick={() => setOverride('')}>
              accept with override…
            </button>
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
        {/* `judge()` refuses outright on this one — a green test run over a
            diff that does not build on the recorded base is evidence about
            some other tree — so it carries the weight every other failure in
            this panel carries, rather than reading as branch metadata. */}
        <Fact
          name="Ancestry"
          value={judgement.descendsFromBase === undefined ? undefined : judgement.descendsFromBase ? 'Verified' : 'Does not descend from base'}
          tone={judgement.descendsFromBase === false ? '#e07070' : undefined}
        />
      </section>
      <section aria-label="Test evidence">
        <Label>Checks</Label>
        {judgement.tests?.length ? judgement.tests.map((test, index) => (
          <div key={`${test.command}-${index}`} style={{ marginBottom: 5 }}>
            <span style={{ color: test.exitCode === 0 ? '#7ee0a3' : '#e07070', fontSize: 10.5 }}>
              {test.exitCode === 0 ? 'passed' : `failed (${test.exitCode})`}
            </span>{' '}
            <code style={{ fontSize: 10.5, color: '#c8cadb' }}>{test.command}</code>
            {test.summary && <div style={{ ...copy, color: '#75798c', whiteSpace: 'pre-wrap' }}>{test.summary}</div>}
          </div>
        )) : (judgement.unreadTests ?? 0) === 0 ? <Missing>None recorded</Missing> : null}
        {(judgement.unreadTests ?? 0) > 0 && (
          <div style={{ ...copy, color: '#e0a34f' }}>
            {judgement.unreadTests} test result{judgement.unreadTests === 1 ? '' : 's'} could not be read
          </div>
        )}
        {judgement.checks && <p style={{ ...copy, color: '#75798c' }}>{judgement.checks}</p>}
      </section>
      <section aria-label="Delivery evidence">
        <Label>Delivery</Label>
        {judgement.prUrl ? (
          <a href={judgement.prUrl} target="_blank" rel="noreferrer" style={{ color: '#8ab4ff', fontSize: 10.5 }}>
            Pull request{judgement.prState ? ` — ${judgement.prState}` : ''}
          </a>
        ) : judgement.prState ? <Fact name="Pull request" value={judgement.prState} /> : <Missing>No pull request recorded</Missing>}
        <List label="Artifacts" values={judgement.artifacts} unread={judgement.unreadArtifacts} empty="None reported" />
        <List label="Risks" values={judgement.risks} unread={judgement.unreadRisks} empty="None reported" risk />
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#75798c', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{children}</div>;
}

function Fact({ name, value, mono = false, tone }: { name: string; value: string | undefined; mono?: boolean; tone?: string }) {
  return <div style={copy}><span style={{ color: '#75798c' }}>{name}: </span><span style={{ fontFamily: mono ? 'ui-monospace, monospace' : undefined, color: tone }}>{value || 'not recorded'}</span></div>;
}

function List({ label, values, unread = 0, empty, risk = false }: {
  label: string;
  values: string[] | undefined;
  unread?: number;
  empty: string;
  risk?: boolean;
}) {
  // Said, not omitted. An entry the board could not read is the one case where
  // `empty` would be a lie rather than a fact, so it takes the line instead.
  const unreadable = unread > 0 ? `${unread} could not be read` : undefined;
  const said = values?.length ? values.join(' · ') : undefined;
  return (
    <div style={{ marginTop: 7 }}>
      <span style={{ ...copy, color: '#75798c' }}>{label}: </span>
      <span style={{ ...copy, color: risk && said ? '#e0a34f' : '#c8cadb' }}>{said ?? (unreadable === undefined ? empty : '')}</span>
      {unreadable && <span style={{ ...copy, color: '#e0a34f' }}>{said ? ` · ${unreadable}` : unreadable}</span>}
    </div>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <div style={{ ...copy, color: '#75798c' }}>{children}</div>;
}

/**
 * The command each path sends, as a value rather than an inline literal.
 *
 * Separated so it can be asserted on: the difference between the two buttons
 * is whether `override` is present at all, and `acceptTask` reads a blank
 * reason as no reason. A regression that sent an empty override on the plain
 * path would record a decision as having been argued for when it was not, and
 * nothing rendered to HTML would show it.
 */
export function acceptCommand(missionId: string, taskId: string, reason?: string): ClientCommand {
  const override = reason?.trim();
  return { type: 'accept_task', missionId, taskId, ...(override ? { override: reason } : {}) };
}

/**
 * The one line a reviewer reads without opening the disclosure.
 *
 * It has to answer the same question the button below it answers, or the
 * collapsed row promises something the panel then refuses — and the reader who
 * never expands the disclosure sees only this line. So it mirrors every reason
 * `evidenceSupportsAcceptance` fails closed: a rejection, results it could not
 * read, and a check it read and can see failed. Adding one there without one
 * here is how the two drift, which has now happened twice.
 *
 * `writing` comes first and outranks all of it: a reason already being typed
 * holds the panel on the override path whatever the verdict says, so the
 * headline has to say so even before there is a judgement to describe.
 *
 * Unreadable risks and artifacts deliberately do NOT appear here. They never
 * block an acceptance — `acceptance.ts` argues a child that admits a risk is
 * behaving better than one that does not — so they are reported where they
 * are, not raised to a verdict they do not change.
 */
export function summary(judgement: Judgement | undefined, writing = false): string {
  if (writing) return 'Recording a reason';
  if (!judgement) return 'Checking completion claim';
  if (judgement.verdict === 'reject') return 'Evidence needs work';
  if ((judgement.unreadTests ?? 0) > 0) return 'Evidence could not be read';
  if (judgement.tests?.some((test) => test.exitCode !== 0)) return 'A check failed';
  if (judgement.missing.length > 0) return `${judgement.missing.length} evidence gap${judgement.missing.length === 1 ? '' : 's'}`;
  return 'Ready for your decision';
}

function shortSha(sha: string | undefined): string | undefined {
  return sha?.slice(0, 8);
}

// Aligns the review under the title, past the 62px status column and 8px gap.
const panel: React.CSSProperties = { marginLeft: 70, padding: '6px 8px', background: '#15172480', borderLeft: '2px solid #33364a' };
const copy: React.CSSProperties = { margin: 0, fontSize: 10.5, color: '#c8cadb', lineHeight: 1.45 };
const action: React.CSSProperties = { fontSize: 10.5, padding: '3px 10px', border: '1px solid #33364a', borderRadius: 5, color: '#a8abbd', cursor: 'pointer' };
const positive: React.CSSProperties = { ...action, color: '#7ee0a3', borderColor: '#2f5a44' };
const warning: React.CSSProperties = { ...action, color: '#e0a34f', borderColor: '#5a4a2f' };
const field: React.CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 3, fontSize: 11.5, padding: '4px 7px', background: '#11131e', border: '1px solid #5a4a2f', borderRadius: 5, color: '#c8cadb' };
