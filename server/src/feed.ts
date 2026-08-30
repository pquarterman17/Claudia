import type { FeedStep } from '@claudia/shared';
import { randomUUID } from 'node:crypto';

/** Maps SDK assistant-message content blocks to abstracted feed steps. */

const TOOL_KIND: Record<string, FeedStep['kind']> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  PowerShell: 'bash',
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** One-line human summary of a tool call's input, used in tiles and approvals. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  // The full plan is rendered in the review surface; the one-liner used in
  // notifications and the activity digest just needs to say what's waiting.
  if (toolName === 'ExitPlanMode') return 'Plan ready for review';
  const cmd = input['command'];
  if (typeof cmd === 'string') return truncate(cmd, 160);
  const filePath = input['file_path'] ?? input['path'] ?? input['pattern'];
  if (typeof filePath === 'string') return truncate(filePath, 160);
  const prompt = input['prompt'] ?? input['description'];
  if (typeof prompt === 'string') return truncate(prompt, 160);
  return truncate(JSON.stringify(input), 160);
}

export function stepFromToolUse(toolName: string, input: Record<string, unknown>): FeedStep {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind: TOOL_KIND[toolName] ?? 'tool',
    title: toolName,
    meta: summarizeToolInput(toolName, input),
  };
}

export function stepFromText(text: string): FeedStep | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind: 'text',
    title: truncate(trimmed.replace(/\s+/g, ' '), 200),
  };
}

export function infoStep(title: string, meta?: string): FeedStep {
  return { id: randomUUID(), ts: Date.now(), kind: 'info', title, meta };
}

export function errorStep(title: string, meta?: string): FeedStep {
  return { id: randomUUID(), ts: Date.now(), kind: 'error', title, meta };
}

export function resultStep(costUsd: number, durMs?: number): FeedStep {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind: 'result',
    title: 'Turn complete',
    meta: `$${costUsd.toFixed(4)} this session`,
    durMs,
  };
}

export function approvalStep(toolName: string, summary: string): FeedStep {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind: 'approval',
    title: `Waiting on approval — ${toolName}`,
    meta: summary,
  };
}
