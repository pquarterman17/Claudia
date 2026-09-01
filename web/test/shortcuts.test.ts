import type { SessionSummary } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { modifierLabel, oldestPendingApproval, resolveShortcut } from '../src/shortcuts';

const key = (over: Partial<Parameters<typeof resolveShortcut>[0]> = {}) => ({
  key: 'Enter',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('modifier by platform', () => {
  it('uses Ctrl off macOS and Cmd on it', () => {
    expect(modifierLabel('win32')).toBe('Ctrl');
    expect(modifierLabel('linux')).toBe('Ctrl');
    expect(modifierLabel('darwin')).toBe('⌘');
  });

  it('reads the matching modifier key for each platform', () => {
    expect(resolveShortcut(key({ ctrlKey: true }), 'win32')).toEqual({ kind: 'approve_oldest' });
    expect(resolveShortcut(key({ metaKey: true }), 'win32')).toBeNull();

    expect(resolveShortcut(key({ metaKey: true }), 'darwin')).toEqual({ kind: 'approve_oldest' });
    expect(resolveShortcut(key({ ctrlKey: true }), 'darwin')).toBeNull();
  });
});

describe('open_palette', () => {
  it('opens on the platform modifier + k, either case', () => {
    expect(resolveShortcut(key({ key: 'k', ctrlKey: true }), 'win32')).toEqual({ kind: 'open_palette' });
    expect(resolveShortcut(key({ key: 'K', ctrlKey: true }), 'win32')).toEqual({ kind: 'open_palette' });
    expect(resolveShortcut(key({ key: 'k', metaKey: true }), 'darwin')).toEqual({ kind: 'open_palette' });
  });

  it('reaches through typing, like the approve chord', () => {
    // Opening the palette must not require leaving the composer first.
    expect(resolveShortcut(key({ key: 'k', ctrlKey: true, targetTag: 'INPUT' }), 'win32')).toEqual({
      kind: 'open_palette',
    });
  });

  it('plain k while typing stays a keystroke', () => {
    expect(resolveShortcut(key({ key: 'k', targetTag: 'INPUT' }), 'win32')).toBeNull();
  });
});

describe('resolveShortcut', () => {
  it('ignores keys pressed without the modifier', () => {
    expect(resolveShortcut(key(), 'win32')).toBeNull();
    expect(resolveShortcut(key({ key: '3' }), 'win32')).toBeNull();
  });

  it('maps digits to session slots, one-based for the user', () => {
    expect(resolveShortcut(key({ key: '1', ctrlKey: true }), 'win32')).toEqual({
      kind: 'focus_session',
      index: 0,
    });
    expect(resolveShortcut(key({ key: '9', ctrlKey: true }), 'win32')).toEqual({
      kind: 'focus_session',
      index: 8,
    });
  });

  it('does not treat 0 as a session slot', () => {
    expect(resolveShortcut(key({ key: '0', ctrlKey: true }), 'win32')).toBeNull();
  });

  it('never steals a plain keystroke while typing', () => {
    // Enter in a composer must send the prompt, not approve something elsewhere.
    expect(resolveShortcut(key({ key: 'a', targetTag: 'INPUT' }), 'win32')).toBeNull();
    expect(resolveShortcut(key({ key: '2', targetTag: 'TEXTAREA' }), 'win32')).toBeNull();
  });

  it('still approves on the modifier chord from inside a text field', () => {
    // Approving without leaving the composer is the point of the chord.
    expect(resolveShortcut(key({ ctrlKey: true, targetTag: 'INPUT' }), 'win32')).toEqual({
      kind: 'approve_oldest',
    });
  });

  it('ignores chords that add Alt, leaving them to the OS', () => {
    expect(resolveShortcut(key({ ctrlKey: true, altKey: true }), 'win32')).toBeNull();
  });
});

function withApproval(id: string, requestedAt: number | null): SessionSummary {
  return {
    id,
    name: id,
    cwd: '/x',
    permissionMode: 'default',
    effortLevel: 'medium',
    thinkingMode: 'adaptive',
    contextPending: false,
    todos: [],
    state: requestedAt === null ? 'working' : 'awaiting_approval',
    startedAt: 0,
    lastActivityAt: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
    queuedPrompts: [],
    ...(requestedAt === null
      ? {}
      : { pendingApproval: { requestId: `r-${id}`, toolName: 'Bash', summary: 'x', requestedAt } }),
  };
}

describe('oldestPendingApproval', () => {
  it('picks the one that has waited longest, not the first in the list', () => {
    const sessions = [withApproval('b', 5000), withApproval('a', 1000), withApproval('c', 9000)];
    expect(oldestPendingApproval(sessions)?.id).toBe('a');
  });

  it('skips sessions with nothing pending', () => {
    expect(oldestPendingApproval([withApproval('a', null), withApproval('b', 2)])?.id).toBe('b');
  });

  it('returns undefined when the queue is empty', () => {
    expect(oldestPendingApproval([withApproval('a', null)])).toBeUndefined();
    expect(oldestPendingApproval([])).toBeUndefined();
  });
});
