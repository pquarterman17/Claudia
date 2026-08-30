import { describe, expect, it } from 'vitest';
import { HookMonitor } from '../src/hook-monitor.js';

/**
 * Fixtures are CAPTURED FROM A LIVE claude-code 2.1.251, by wiring a hook that
 * dumped its stdin and running a real session, not transcribed from the
 * published reference -- which names four of these fields wrongly
 * (`start_reason`, `end_reason`, `user_input`, `tool_output`). Every one of
 * those would have failed silently: a tile with no prompt, no reply and a
 * session that never ends.
 *
 * Trimmed only of transcript_path and the unchanging ids.
 */
const SID = 'f710a39b-ff44-5242-b483-a08a3904597f';
const CWD = '/tmp/hookprobe';

const sessionStart = { session_id: SID, cwd: CWD, source: 'startup', hook_event_name: 'SessionStart' };
const userPrompt = {
  session_id: SID,
  cwd: CWD,
  prompt_id: '6d1778ad-cfe0-4079-8c0b-88d3141dd6d4',
  permission_mode: 'acceptEdits',
  prompt: 'Use the Write tool to create probe.txt containing exactly: hi. Then reply done.',
  hook_event_name: 'UserPromptSubmit',
};
const preToolUse = {
  session_id: SID,
  cwd: CWD,
  permission_mode: 'acceptEdits',
  effort: { level: 'high' },
  tool_name: 'Write',
  tool_input: { file_path: `${CWD}/probe.txt`, content: 'hi' },
  tool_use_id: 'toolu_013NveR7aossNqX9mxeFS5Hq',
  hook_event_name: 'PreToolUse',
};
const postToolUse = {
  ...preToolUse,
  tool_response: { type: 'create', filePath: `${CWD}/probe.txt` },
  duration_ms: 7,
  hook_event_name: 'PostToolUse',
};
const stop = {
  session_id: SID,
  cwd: CWD,
  permission_mode: 'acceptEdits',
  stop_hook_active: false,
  last_assistant_message: 'done',
  background_tasks: [],
  session_crons: [],
  hook_event_name: 'Stop',
};
const sessionEnd = { session_id: SID, cwd: CWD, reason: 'other', hook_event_name: 'SessionEnd' };

describe('HookMonitor', () => {
  it('walks a real session from start to end', () => {
    const monitor = new HookMonitor();
    const only = () => monitor.list()[0];

    monitor.record(sessionStart);
    expect(only()).toMatchObject({ id: SID, cwd: CWD, state: 'idle', source: 'startup' });

    monitor.record(userPrompt);
    expect(only()).toMatchObject({ state: 'working', permissionMode: 'acceptEdits' });
    expect(only()?.lastPrompt).toContain('Use the Write tool');

    monitor.record(preToolUse);
    expect(only()).toMatchObject({ state: 'working', lastTool: 'Write' });

    monitor.record(postToolUse);
    // A turn continues after a tool call; only Stop ends it. Going idle here
    // would flicker the tile on every step of a long turn.
    expect(only()).toMatchObject({ state: 'working', lastTool: 'Write' });

    monitor.record(stop);
    expect(only()).toMatchObject({ state: 'idle', lastMessage: 'done' });
    expect(only()?.lastTool).toBeUndefined();

    monitor.record(sessionEnd);
    expect(only()).toMatchObject({ state: 'ended', endReason: 'other' });
  });

  it('reads the prompt from `prompt`, which is not what the docs call it', () => {
    const monitor = new HookMonitor();
    monitor.record({ ...userPrompt, user_input: 'the documented name, which is wrong' });
    expect(monitor.list()[0]?.lastPrompt).toContain('Use the Write tool');
  });

  it('reads the start source from `source` and the end from `reason`', () => {
    const monitor = new HookMonitor();
    monitor.record({ ...sessionStart, start_reason: 'documented-but-wrong' });
    expect(monitor.list()[0]?.source).toBe('startup');
    monitor.record({ ...sessionEnd, end_reason: 'documented-but-wrong' });
    expect(monitor.list()[0]?.endReason).toBe('other');
  });

  it('ignores a payload with no session or no event to attach it to', () => {
    const monitor = new HookMonitor();
    expect(monitor.record({ hook_event_name: 'Stop' })).toBe(false);
    expect(monitor.record({ session_id: SID })).toBe(false);
    expect(monitor.record('not an object')).toBe(false);
    expect(monitor.record(null)).toBe(false);
    expect(monitor.size).toBe(0);
  });

  it('keeps a session alive on an event it does not model', () => {
    const monitor = new HookMonitor();
    monitor.record(sessionStart, 1000);
    monitor.record({ session_id: SID, hook_event_name: 'PostCompact' }, 5000);
    expect(monitor.list()[0]).toMatchObject({ state: 'idle', lastEventAt: 5000 });
  });

  it('reports a permission prompt as waiting on a human', () => {
    const monitor = new HookMonitor();
    monitor.record(preToolUse);
    monitor.record({ session_id: SID, hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(monitor.list()[0]).toMatchObject({ state: 'needs_you', needs: 'permission_prompt' });
  });

  it('leaves the state alone for a notification it does not recognise', () => {
    // The notification payload is the one shape that could not be captured, so
    // an unknown type must not invent a state.
    const monitor = new HookMonitor();
    monitor.record(preToolUse);
    monitor.record({ session_id: SID, hook_event_name: 'Notification', notification_type: 'auth_success' });
    expect(monitor.list()[0]?.state).toBe('working');
  });

  it('clears the waiting flag once the session moves again', () => {
    const monitor = new HookMonitor();
    monitor.record({ session_id: SID, hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(monitor.list()[0]?.state).toBe('needs_you');
    monitor.record(stop);
    expect(monitor.list()[0]).toMatchObject({ state: 'idle' });
    expect(monitor.list()[0]?.needs).toBeUndefined();
  });

  it('hides a session Claudia already owns a tile for', () => {
    // The same global hook fires for sessions Claudia launched, so without this
    // every owned session appears twice: once live, once as a ghost.
    const monitor = new HookMonitor();
    monitor.record(sessionStart);
    expect(monitor.list(new Set([SID]))).toEqual([]);
    expect(monitor.list()).toHaveLength(1);
  });

  it('orders by most recent activity', () => {
    const monitor = new HookMonitor();
    monitor.record({ ...sessionStart, session_id: 'older' }, 1000);
    monitor.record({ ...sessionStart, session_id: 'newer' }, 2000);
    expect(monitor.list().map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('broadcasts on real news, not on every hook', () => {
    const monitor = new HookMonitor();
    expect(monitor.record(sessionStart), 'first sighting').toBe(true);
    expect(monitor.record(preToolUse), 'started a tool').toBe(true);
    expect(monitor.record(preToolUse), 'same tool again').toBe(false);
    expect(monitor.record(stop), 'turn ended').toBe(true);
  });

  it('forgets a session that went quiet, which is how a killed terminal looks', () => {
    // Ctrl+C never sends SessionEnd, so a working tile would otherwise claim to
    // be working forever.
    const monitor = new HookMonitor();
    monitor.record(preToolUse, 1000);
    expect(monitor.prune(60_000, 30_000)).toBe(false);
    expect(monitor.prune(60_000, 90_000)).toBe(true);
    expect(monitor.list()).toEqual([]);
  });

  it('keeps an ended session briefly, then drops it', () => {
    const monitor = new HookMonitor();
    monitor.record(sessionEnd, 1000);
    expect(monitor.prune(60 * 60_000, 30_000)).toBe(false);
    expect(monitor.list()[0]?.state).toBe('ended');
    expect(monitor.prune(60 * 60_000, 120_000)).toBe(true);
  });

  it('follows a working directory that changes mid-session', () => {
    const monitor = new HookMonitor();
    monitor.record(sessionStart);
    monitor.record({ ...stop, cwd: '/tmp/moved' });
    expect(monitor.list()[0]?.cwd).toBe('/tmp/moved');
  });
});
