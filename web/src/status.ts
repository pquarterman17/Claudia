import type { SessionState } from '@claudia/shared';

/** Status → presentation mapping, lifted from the design prototype. */

export const COLORS = {
  accent: '#9184d9',
  accentDim: '#796cbf',
  warn: '#d9b184',
  err: '#d98484',
  ok: '#8fc4a8',
  mute: '#75798c',
  text: '#cfd3e5',
} as const;

export interface StatusView {
  label: string;
  short: string;
  color: string;
  dot: string;
  pulse: boolean;
}

const STATUS: Record<SessionState, StatusView> = {
  starting: { label: 'starting', short: 'start', color: COLORS.accent, dot: COLORS.accent, pulse: true },
  working: { label: 'working', short: 'run', color: COLORS.accent, dot: COLORS.accent, pulse: true },
  awaiting_approval: { label: 'awaiting approval', short: 'wait', color: COLORS.warn, dot: COLORS.warn, pulse: true },
  idle: { label: 'idle', short: 'idle', color: COLORS.mute, dot: '#4a4e5e', pulse: false },
  error: { label: 'blocked · error', short: 'err', color: COLORS.err, dot: COLORS.err, pulse: false },
  stopped: { label: 'stopped', short: 'stop', color: COLORS.mute, dot: '#4a4e5e', pulse: false },
};

export function statusOf(state: SessionState): StatusView {
  return STATUS[state];
}

export const FEED_ICONS: Record<string, { icon: string; color: string }> = {
  read: { icon: '◔', color: COLORS.mute },
  edit: { icon: '✎', color: COLORS.accent },
  bash: { icon: '⌘', color: COLORS.mute },
  tool: { icon: '⏺', color: COLORS.mute },
  text: { icon: '·', color: COLORS.text },
  approval: { icon: '⏸', color: COLORS.warn },
  result: { icon: '✓', color: COLORS.ok },
  info: { icon: '○', color: COLORS.mute },
  error: { icon: '✕', color: COLORS.err },
};
