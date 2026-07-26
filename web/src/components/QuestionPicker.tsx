import type { PendingQuestion } from '@claudia/shared';
import { useState } from 'react';
import { send } from '../store';

interface Props {
  sessionId: string;
  question: PendingQuestion;
}

/**
 * Renders AskUserQuestion as a step-through wizard: one question at a time,
 * matching the terminal, instead of every question stacked into a scroll box.
 *
 * Selecting an option advances; on the last question it submits immediately —
 * so the common single-question case is answered in one click. Free text
 * advances on Enter. The answers travel back through the permission callback
 * as `updatedInput.answers`, keyed by question text.
 */
export function QuestionPicker({ sessionId, question }: Props) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState('');
  /** Toggled labels for a multi-select question; single-select ignores this. */
  const [picked, setPicked] = useState<string[]>([]);

  const questions = question.questions;
  const clamped = Math.min(step, questions.length - 1);
  const current = questions[clamped];
  if (!current) return null;
  const isLast = clamped === questions.length - 1;

  const submit = (all: Record<string, string>) => {
    send({ type: 'answer_question', sessionId, requestId: question.requestId, answers: all });
  };

  /** Records this question's answer, then advances or submits. */
  const answerWith = (value: string) => {
    if (!value.trim()) return;
    const all = { ...answers, [current.question]: value.trim() };
    setAnswers(all);
    setOther('');
    setPicked([]);
    if (isLast) submit(all);
    else setStep(clamped + 1);
  };

  /** Multi-select: clicking toggles; Next/Answer commits the joined set. */
  const toggle = (label: string) =>
    setPicked((p) => (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]));

  return (
    <div
      style={{
        flex: 'none',
        padding: '10px 11px',
        background: '#221f31',
        borderTop: '1px solid #423a6a',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        {current.header && (
          <span
            style={{
              fontSize: 9,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: '#b5abfc',
              border: '1px solid #423a6a',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            {current.header}
          </span>
        )}
        <span style={{ flex: 1, fontSize: 11.5, color: '#e4e7f5' }}>{current.question}</span>
        {questions.length > 1 && (
          <span style={{ fontSize: 10, color: '#75798c', fontVariantNumeric: 'tabular-nums' }}>
            {clamped + 1} of {questions.length}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {current.options.map((option) => {
          const on = current.multiSelect && picked.includes(option.label);
          return (
          <button
            key={option.label}
            onClick={() => (current.multiSelect ? toggle(option.label) : answerWith(option.label))}
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              borderRadius: 6,
              padding: '5px 8px',
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              border: `1px solid ${on ? '#796cbf' : '#33364a'}`,
              background: on ? '#2b2741' : 'transparent',
              color: on ? '#d2cefd' : '#cfd3e5',
            }}
          >
            <span style={{ display: 'block', fontWeight: 500 }}>{option.label}</span>
            {option.description && (
              <span style={{ display: 'block', fontSize: 10, color: '#75798c', marginTop: 1 }}>
                {option.description}
              </span>
            )}
          </button>
          );
        })}

        {current.multiSelect && (
          <button
            className="btn btn-primary"
            disabled={picked.length === 0}
            onClick={() => answerWith(picked.join(', '))}
            style={{ fontSize: 11, padding: '4px 10px', alignSelf: 'flex-start' }}
          >
            {isLast ? 'Answer' : 'Next'} ({picked.length})
          </button>
        )}

        <input
          className="input"
          value={other}
          placeholder="or type your own and press Enter…"
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              answerWith(other);
            }
          }}
          style={{ fontSize: 11, padding: '4px 7px' }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {clamped > 0 && (
          <button
            className="btn btn-ghost"
            onClick={() => setStep(clamped - 1)}
            style={{ fontSize: 11, padding: '2px 8px', color: '#9397ab' }}
          >
            ← Back
          </button>
        )}
        <span style={{ flex: 1, fontSize: 10.5, color: '#75798c' }}>
          {current.multiSelect
            ? 'pick all that apply'
            : isLast
              ? 'picking an option answers immediately'
              : 'picking an option moves to the next question'}
        </span>
        <button
          className="btn btn-ghost"
          onClick={() =>
            send({ type: 'deny', sessionId, requestId: question.requestId, message: 'User dismissed the question' })
          }
          style={{ fontSize: 11, padding: '3px 9px', color: '#9397ab' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
