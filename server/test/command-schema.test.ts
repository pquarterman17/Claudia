import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/command-schema.js';
import { MAX_FRAME_BYTES, MAX_IMAGE_DATA_LEN, MAX_TEXT_LEN, MAX_TOTAL_TEXT_LEN } from '../src/command-fields.js';

/**
 * One valid example per ClientCommand member (shared/src/protocol.ts), kept
 * as a flat table so adding a 55th command type is a one-line addition here
 * rather than a new test to remember to write. The count below is the real
 * guardrail: it fails the moment this list and the union drift apart.
 */
const VALID: Array<[string, Record<string, unknown>]> = [
  ['launch_session', {
    type: 'launch_session', cwd: '/repo', agent: 'claude', worktreeBranch: 'feature/x',
    prompt: 'do the thing', model: 'sonnet', permissionMode: 'default', effortLevel: 'medium', thinkingMode: 'adaptive',
  }],
  ['list_saved_sessions', { type: 'list_saved_sessions', cwd: '/repo' }],
  ['get_saved_session_detail', { type: 'get_saved_session_detail', sessionId: 's1', cwd: '/repo' }],
  ['resume_saved_session', { type: 'resume_saved_session', sessionId: 's1', cwd: '/repo', agent: 'claude', permissionMode: 'default' }],
  ['fork_saved_session', { type: 'fork_saved_session', sessionId: 's1', cwd: '/repo' }],
  ['rename_saved_session', { type: 'rename_saved_session', sessionId: 's1', title: 'New title' }],
  ['tag_saved_session', { type: 'tag_saved_session', sessionId: 's1', tag: 'important' }],
  ['rewind_files', { type: 'rewind_files', sessionId: 's1', checkpointId: 'cp1' }],
  ['send_prompt', {
    type: 'send_prompt', sessionId: 's1', text: 'hello',
    images: [{ mediaType: 'image/png', data: 'YWJj', name: 'a.png' }],
  }],
  ['approve', { type: 'approve', sessionId: 's1', requestId: 'r1' }],
  ['deny', { type: 'deny', sessionId: 's1', requestId: 'r1', message: 'no' }],
  ['always_allow_project', { type: 'always_allow_project', sessionId: 's1', requestId: 'r1' }],
  ['answer_question', { type: 'answer_question', sessionId: 's1', requestId: 'r1', answers: { 'tabs or spaces?': 'spaces' } }],
  ['interrupt', { type: 'interrupt', sessionId: 's1' }],
  ['stop_session', { type: 'stop_session', sessionId: 's1' }],
  ['remove_session', { type: 'remove_session', sessionId: 's1' }],
  ['browse_folder', { type: 'browse_folder' }],
  ['set_permission_mode', { type: 'set_permission_mode', sessionId: 's1', mode: 'default' }],
  ['require_approvals_everywhere', { type: 'require_approvals_everywhere' }],
  ['toggle_finish_action', { type: 'toggle_finish_action', action: 'notify' }],
  ['move_finish_action', { type: 'move_finish_action', action: 'notify', direction: 'up' }],
  ['clear_finish_chain', { type: 'clear_finish_chain' }],
  ['arm_trigger', { type: 'arm_trigger', confirmDestructive: true }],
  ['disarm_trigger', { type: 'disarm_trigger' }],
  ['bulk', { type: 'bulk', op: 'approve_all' }],
  ['set_plan_tier', { type: 'set_plan_tier', tier: 'pro' }],
  ['set_custom_ceilings', { type: 'set_custom_ceilings', sessionTokens: 1000, weeklyTokens: 5000 }],
  ['fetch_real_usage', { type: 'fetch_real_usage', sessionId: 's1' }],
  ['set_countdown', { type: 'set_countdown', seconds: 30 }],
  ['rename_session', { type: 'rename_session', sessionId: 's1', title: 'New' }],
  ['set_model', { type: 'set_model', sessionId: 's1', model: 'sonnet' }],
  ['set_effort', { type: 'set_effort', sessionId: 's1', effortLevel: 'high' }],
  ['set_thinking', { type: 'set_thinking', sessionId: 's1', thinkingMode: 'disabled' }],
  ['refresh_context', { type: 'refresh_context', sessionId: 's1' }],
  ['get_models', { type: 'get_models', sessionId: 's1' }],
  ['get_commands', { type: 'get_commands', sessionId: 's1' }],
  ['get_mcp_status', { type: 'get_mcp_status', sessionId: 's1' }],
  ['reconnect_mcp', { type: 'reconnect_mcp', sessionId: 's1', serverName: 'srv' }],
  ['toggle_mcp', { type: 'toggle_mcp', sessionId: 's1', serverName: 'srv', enabled: true }],
  ['get_effective_settings', { type: 'get_effective_settings', sessionId: 's1' }],
  ['stop_task', { type: 'stop_task', sessionId: 's1', taskId: 't1' }],
  ['get_transcript', { type: 'get_transcript', sessionId: 's1' }],
  ['set_stop_on_close', { type: 'set_stop_on_close', seconds: 60 }],
  ['save_template', { type: 'save_template', template: { name: 'tmpl', cwd: '/repo', permissionMode: 'default', prompt: 'go' } }],
  ['set_hook_monitor', { type: 'set_hook_monitor', enabled: true }],
  ['search_files', { type: 'search_files', sessionId: 's1', query: 'foo' }],
  ['set_output_style', { type: 'set_output_style', sessionId: 's1', style: 'concise' }],
  ['set_agent', { type: 'set_agent', sessionId: 's1', agent: 'codex' }],
  ['start_debate', {
    type: 'start_debate', cwd: '/repo', objective: 'ship it', subject: 'diff',
    authorSessionId: 's1', author: 'claude', reviewer: 'codex', rounds: 2,
  }],
  ['start_crew', { type: 'start_crew', cwd: '/repo', objective: 'ship it', planner: 'claude', workers: ['claude', 'codex'], maxTasks: 3 }],
  ['save_toolkit_action', { type: 'save_toolkit_action', action: { id: 'a1', name: 'Run tests', prompt: 'run the tests' } }],
  ['delete_toolkit_action', { type: 'delete_toolkit_action', id: 'a1' }],
  ['delete_template', { type: 'delete_template', name: 'tmpl' }],
  ['ping', { type: 'ping' }],
];

describe('parseCommand: every ClientCommand member', () => {
  // Pinned so a member added to the union without a row above fails here,
  // not silently — 54 is the count in shared/src/protocol.ts as of this PR.
  it('covers all 54 members', () => {
    expect(VALID).toHaveLength(54);
  });

  it.each(VALID)('accepts a valid %s', (_label, cmd) => {
    const result = parseCommand(cmd);
    expect(result).toEqual({ ok: true, cmd });
  });
});

describe('parseCommand: malformed input', () => {
  it.each([
    ['a string', 'not an object'],
    ['a number', 42],
    ['null', null],
    ['an array', ['ping']],
  ])('rejects %s', (_label, raw) => {
    const result = parseCommand(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects an object with no type', () => {
    const result = parseCommand({ sessionId: 's1' });
    expect(result).toEqual({ ok: false, reason: 'command has no string "type"' });
  });

  it('rejects a non-string type', () => {
    const result = parseCommand({ type: 42 });
    expect(result).toEqual({ ok: false, reason: 'command has no string "type"' });
  });

  it('rejects an unknown type, naming it', () => {
    const result = parseCommand({ type: 'launch_the_missiles' });
    expect(result).toEqual({ ok: false, reason: 'unknown command type "launch_the_missiles"' });
  });

  it('does not echo an unbounded unknown type back whole', () => {
    const huge = 'x'.repeat(10_000);
    const result = parseCommand({ type: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeLessThan(200);
  });

  it('rejects a field of the wrong type', () => {
    const result = parseCommand({ type: 'approve', sessionId: 123, requestId: 'r1' });
    expect(result).toEqual({ ok: false, reason: 'approve: sessionId must be a string' });
  });

  it('rejects a missing required field', () => {
    const result = parseCommand({ type: 'approve', sessionId: 's1' });
    expect(result).toEqual({ ok: false, reason: 'approve: requestId is required' });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects "%s" as a key anywhere in the graph', (key) => {
    // Built via JSON.parse, like the gateway's real input: an object literal
    // with a "__proto__" key sets the prototype instead of creating an own
    // property, which would test the wrong thing entirely.
    const raw = JSON.parse(`{"type":"send_prompt","sessionId":"s1","text":"hi","images":[{"${key}":1}]}`);
    const result = parseCommand(raw);
    expect(result).toEqual({ ok: false, reason: `forbidden key "${key}"` });
  });

  it('rejects a string over the field bound', () => {
    const result = parseCommand({ type: 'rename_session', sessionId: 's1', title: 'x'.repeat(2_001) });
    expect(result).toEqual({ ok: false, reason: 'rename_session: title must be a string' });
  });

  it('rejects an array over its semantic bound', () => {
    const result = parseCommand({
      type: 'start_crew', cwd: '/repo', objective: 'x', planner: 'claude',
      workers: Array(9).fill('claude'), maxTasks: 3,
    });
    expect(result).toEqual({ ok: false, reason: 'start_crew: workers must be a non-empty array of agent kinds' });
  });

  it('rejects an array over the generic structural bound anywhere in the graph', () => {
    const result = parseCommand({ type: 'ping', junk: Array(201).fill(0) });
    expect(result).toEqual({ ok: false, reason: 'array has too many entries (max 200)' });
  });

  it('rejects nesting past the depth bound', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    const result = parseCommand({ type: 'ping', junk: deep });
    expect(result).toEqual({ ok: false, reason: 'nesting too deep (max 6)' });
  });
});

describe('total content budget', () => {
  it('rejects a huge string hiding under a field no command declares', () => {
    // Found in review. `ping` declares no fields, so the junk was never looked
    // at — and the allocation and parse were paid anyway, as fast as a local
    // page could send them.
    const result = parseCommand({ type: 'ping', junk: 'x'.repeat(MAX_TOTAL_TEXT_LEN + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('too much text');
  });

  it('charges strings under unknown fields on any command, not just ping', () => {
    const result = parseCommand({
      type: 'send_prompt',
      sessionId: 's1',
      text: 'hello',
      junk: 'x'.repeat(MAX_TOTAL_TEXT_LEN),
    });
    expect(result.ok).toBe(false);
  });

  it('charges nested strings, not only top-level ones', () => {
    const result = parseCommand({
      type: 'ping',
      junk: { deeper: ['x'.repeat(MAX_TOTAL_TEXT_LEN / 2), 'x'.repeat(MAX_TOTAL_TEXT_LEN / 2 + 2)] },
    });
    expect(result.ok).toBe(false);
  });

  it('charges long keys too, so the cost cannot move into the field name', () => {
    // Bounded by MAX_ARRAY_LEN keys, so the only way past the budget is long
    // names — which is exactly the move this charges for.
    const payload: Record<string, unknown> = { type: 'ping' };
    for (let i = 0; i < 199; i++) payload[`k${i}`.padEnd(MAX_TEXT_LEN - 1, 'x')] = 1;
    expect(parseCommand(payload).ok).toBe(false);
  });

  it('sums across siblings rather than checking each alone', () => {
    // Each string is individually legal; together they are not.
    const half = 'x'.repeat(Math.floor(MAX_TOTAL_TEXT_LEN / 2) + 1);
    expect(parseCommand({ type: 'ping', a: half, b: half }).ok).toBe(false);
  });

  it('still accepts the largest legitimate command', () => {
    // Four images at the documented maximum plus a prompt: the budget exists
    // to bound abuse, not to break the real ceiling the browser already allows.
    const images = Array.from({ length: 4 }, () => ({
      mediaType: 'image/png',
      data: 'a'.repeat(MAX_IMAGE_DATA_LEN),
      name: 'screenshot-with-a-long-but-ordinary-file-name.png',
    }));
    // A MAXIMAL prompt, not a token one. The earlier version of this test sent
    // the word "look", so it never exercised the sum it was written to protect
    // — and the budget was in fact 172 characters too small for the real thing.
    const result = parseCommand({
      type: 'send_prompt',
      sessionId: 's1',
      text: 'x'.repeat(MAX_TEXT_LEN),
      images,
    });
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  it('leaves an ordinary command well inside the budget', () => {
    expect(parseCommand({ type: 'send_prompt', sessionId: 's1', text: 'hello' }).ok).toBe(true);
  });
});

describe('MAX_FRAME_BYTES', () => {
  it('sits above the content budget, so ws never rejects a legal command', () => {
    // The frame ceiling is the outer limit; if it were tighter than the budget
    // a legitimate four-image prompt would be dropped before parsing, with no
    // reason ever reaching the client.
    expect(MAX_FRAME_BYTES).toBeGreaterThan(MAX_TOTAL_TEXT_LEN);
  });
});
