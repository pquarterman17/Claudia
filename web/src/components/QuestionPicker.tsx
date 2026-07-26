import type { PendingQuestion } from '@claudia/shared';
import { useState } from 'react';
import { send } from '../store';
import { COLORS } from '../status';

interface Props {
  sessionId: string;
  question: PendingQuestion;
}

/**
 * Renders AskUserQuestion as a picker, matching what the terminal shows.
 *
 * The answer travels back through the permission callback as
 * `updatedInput.answers`, keyed by question text — so this is not an approval
 * prompt even though it arrives down the same channel.
 */
export function QuestionPicker({ sessionId, question }: Props) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerFor = (q: string): string => other[q]?.trim() || chosen[q] || '';
  const complete = question.questions.every((q) => answerFor(q.question));

  const submit = () => {
    if (!complete) return;
    const answers: Record<string, string> = {};
    for (const q of question.questions) answers[q.question] = answerFor(q.question);
    send({ type: 'answer_question', sessionId, requestId: question.requestId, answers });
  };

  return (
    <div
      style={{
        flex: 'none',
        maxHeight: '55%',
        overflowY: 'auto',
        padding: '10px 11px',
        background: '#221f31',
        borderTop: '1px solid #423a6a',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {question.questions.map((q) => (
        <div key={q.question}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 5 }}>
            {q.header && (
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
                {q.header}
              </span>
            )}
            <span style={{ fontSize: 11.5, color: '#e4e7f5' }}>{q.question}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {q.options.map((o) => {
              const on = chosen[q.question] === o.label && !other[q.question];
              return (
                <button
                  key={o.label}
                  title={o.description}
                  onClick={() => {
                    setChosen((c) => ({ ...c, [q.question]: o.label }));
                    setOther((c) => ({ ...c, [q.question]: '' }));
                  }}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderRadius: 6,
                    padding: '5px 8px',
                    fontFamily: 'var(--font-body)',
                    fontSize: 11,
                    border: `1px solid ${on ? '#796cbf' : '#33364a'}`,
                    background: on ? '#2b2741' : 'transparent',
                    color: on ? '#d2cefd' : '#9397ab',
                  }}
                >
                  <span style={{ display: 'block', fontWeight: 500 }}>{o.label}</span>
                  {o.description && (
                    <span style={{ display: 'block', fontSize: 10, color: '#75798c', marginTop: 1 }}>
                      {o.description}
                    </span>
                  )}
                </button>
              );
            })}

            {/* The terminal always offers a free-text escape hatch; so does this. */}
            <input
              className="input"
              value={other[q.question] ?? ''}
              placeholder="or type your own answer…"
              onChange={(e) => setOther((c) => ({ ...c, [q.question]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              style={{ fontSize: 11, padding: '4px 7px' }}
            />
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, fontSize: 10.5, color: '#75798c' }}>
          {complete ? 'ready to send' : 'pick an option, or type your own'}
        </span>
        <button
          className="btn btn-ghost"
          onClick={() =>
            send({
              type: 'deny',
              sessionId,
              requestId: question.requestId,
              message: 'User dismissed the question',
            })
          }
          style={{ fontSize: 11, padding: '3px 9px', color: '#9397ab' }}
        >
          Dismiss
        </button>
        <button
          className="btn btn-primary"
          disabled={!complete}
          onClick={submit}
          style={{
            fontSize: 11,
            padding: '3px 12px',
            borderColor: complete ? '#9184d9' : '#3f424d',
            color: complete ? '#b5abfc' : COLORS.mute,
          }}
        >
          Answer
        </button>
      </div>
    </div>
  );
}
