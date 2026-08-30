/**
 * The files one session actually wrote.
 *
 * This exists so the "commit + push" finish action can stage a session's own
 * work and nothing else. A repository is routinely dirty for reasons that have
 * nothing to do with the session running in it — a half-finished edit in the
 * owner's editor, a config file tweaked by hand — and `git add -A` would sweep
 * all of it into an unattended commit that then gets pushed. Attribution has to
 * come from the session, because git cannot tell who changed a file.
 *
 * A write counts only once its tool result lands successfully: a denied
 * approval and a failed edit both come back as an error result, and neither
 * wrote anything. Codex reports its file changes already applied, with no id to
 * match against, so those are recorded directly.
 */
export interface FileWrite {
  path: string;
  /** The tool call that will confirm this write, when there is one. */
  toolUseId?: string;
}

export class TouchedFiles {
  /** Writes announced but not yet confirmed, keyed by the call that will confirm them. */
  private readonly pending = new Map<string, string>();
  private readonly written = new Set<string>();

  record(write: FileWrite): void {
    if (!write.path) return;
    if (write.toolUseId) this.pending.set(write.toolUseId, write.path);
    else this.written.add(write.path);
  }

  /**
   * Resolves a pending write. Unknown ids are the normal case — most tool calls
   * write nothing — so they are silently ignored rather than treated as a miss.
   */
  settle(toolUseId: string, isError: boolean): void {
    const path = this.pending.get(toolUseId);
    if (path === undefined) return;
    this.pending.delete(toolUseId);
    if (!isError) this.written.add(path);
  }

  /** Confirmed writes, in the order they were first made. */
  get paths(): string[] {
    return [...this.written];
  }
}
