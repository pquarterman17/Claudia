import type { SessionTodo } from '@claudia/shared';

const MARK: Record<SessionTodo['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
};

const COLOR: Record<SessionTodo['status'], string> = {
  pending: '#9397ab',
  in_progress: '#b5abfc',
  completed: '#85b58b',
};

/** The last explicit TodoWrite update — never a todo list guessed from prose. */
export function TodoPanel({ todos }: { todos: SessionTodo[] }) {
  if (!todos.length) return null;
  const incomplete = todos.filter((todo) => todo.status !== 'completed').length;
  return (
    <details style={{ borderBottom: '1px solid #262832', padding: '5px 9px' }}>
      <summary style={{ cursor: 'pointer', fontSize: 10.5, color: '#9397ab' }}>
        Plan · {incomplete ? `${incomplete} remaining` : 'complete'}
      </summary>
      <ul aria-label="Session plan" style={{ margin: '5px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 3 }}>
        {todos.map((todo, index) => (
          <li key={`${todo.content}-${index}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11.5 }}>
            <span aria-hidden="true" style={{ color: COLOR[todo.status], width: 12 }}>{MARK[todo.status]}</span>
            <span style={{ color: todo.status === 'completed' ? '#75798c' : '#e4e7f5', textDecoration: todo.status === 'completed' ? 'line-through' : undefined }}>
              {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
