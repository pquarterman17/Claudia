import type { SessionTodo, TranscriptItem } from '@claudia/shared';

const VALID_STATUS = new Set<SessionTodo['status']>(['pending', 'in_progress', 'completed']);

/** Tracks the latest TodoWrite payload without attempting to infer todos from prose. */
export class TodoTracker {
  private current: SessionTodo[] = [];

  get todos(): SessionTodo[] { return this.current; }

  capture(item: TranscriptItem): boolean {
    if (item.kind !== 'tool_use' || item.toolName !== 'TodoWrite') return false;
    try {
      const parsed = JSON.parse(item.text) as { todos?: unknown };
      if (!Array.isArray(parsed.todos)) return false;
      const todos: SessionTodo[] = [];
      for (const raw of parsed.todos) {
        if (!raw || typeof raw !== 'object') continue;
        const todo = raw as Record<string, unknown>;
        const content = typeof todo['content'] === 'string' ? todo['content'].trim() : '';
        const status = todo['status'];
        if (!content || typeof status !== 'string' || !VALID_STATUS.has(status as SessionTodo['status'])) continue;
        const activeForm = typeof todo['activeForm'] === 'string' ? todo['activeForm'].trim() : undefined;
        todos.push({ content, status: status as SessionTodo['status'], ...(activeForm ? { activeForm } : {}) });
      }
      this.current = todos;
      return true;
    } catch {
      return false;
    }
  }
}
