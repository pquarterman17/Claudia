import { describe, expect, it } from 'vitest';
import { TodoTracker } from '../src/todo-tracker.js';

describe('TodoTracker', () => {
  it('uses the latest structured TodoWrite payload', () => {
    const tracker = new TodoTracker();
    expect(tracker.capture({ ts: 1, kind: 'tool_use', toolName: 'TodoWrite', text: JSON.stringify({
      todos: [
        { content: 'Inspect app', status: 'completed' },
        { content: 'Ship change', status: 'in_progress', activeForm: 'Shipping change' },
      ],
    }) })).toBe(true);
    expect(tracker.todos).toEqual([
      { content: 'Inspect app', status: 'completed' },
      { content: 'Ship change', status: 'in_progress', activeForm: 'Shipping change' },
    ]);
  });

  it('ignores prose, malformed JSON and unknown statuses', () => {
    const tracker = new TodoTracker();
    expect(tracker.capture({ ts: 1, kind: 'assistant', text: 'todo: pretend' })).toBe(false);
    expect(tracker.capture({ ts: 1, kind: 'tool_use', toolName: 'TodoWrite', text: '{' })).toBe(false);
    expect(tracker.capture({ ts: 1, kind: 'tool_use', toolName: 'TodoWrite', text: JSON.stringify({ todos: [{ content: 'bad', status: 'later' }] }) })).toBe(true);
    expect(tracker.todos).toEqual([]);
  });
});
