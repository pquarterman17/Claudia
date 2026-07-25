import type { HostPlatform, SessionSummary } from '@claudia/shared';
import { modifierLabel } from '../shortcuts';

interface Props {
  sessions: SessionSummary[];
  platform?: HostPlatform;
}

const HOST_NAME: Record<HostPlatform, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/** Footer: a one-line state summary and the shortcut hints for this platform. */
export function StatusFooter({ sessions, platform }: Props) {
  const working = sessions.filter((s) => s.state === 'working' || s.state === 'starting').length;
  const waiting = sessions.filter((s) => s.pendingApproval).length;
  const blocked = sessions.filter((s) => s.state === 'error').length;
  const mod = modifierLabel(platform);

  return (
    <div
      style={{
        flex: 'none',
        height: 26,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 16px',
        borderTop: '1px solid #2c2f3d',
        background: '#161826',
        fontSize: 10.5,
        color: '#75798c',
      }}
    >
      <span>
        {working} working · {waiting} awaiting approval · {blocked} blocked
      </span>
      <span style={{ flex: 1 }} />
      <span>
        {mod}1–9 jump · {mod}⏎ approve oldest · {mod}U usage
        {platform ? ` · on ${HOST_NAME[platform]}` : ''}
      </span>
    </div>
  );
}
