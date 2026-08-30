import type { ClientCommand, ServerEvent, SessionSummary } from '@claudia/shared';
import { CrewRunner } from './crew-runner.js';
import { DebateRunner } from './debate-runner.js';
import type { SessionManager } from './session-manager.js';

/**
 * The runs Claudia drives on its own, behind one door.
 *
 * There are two of them — a debate between two agents, and a crew splitting an
 * objective — and the gateway needs exactly the same four things from each:
 * which sessions they own (so the idle-stop does not kill one mid-run), a look
 * at every session update (so a parked approval does not deadlock one), a
 * replay for a browser that just connected, and a command to start one. Wiring
 * each of those separately into gateway.ts means every future kind of run
 * touches the dispatcher again, and gateway.ts has been at its size ceiling
 * five times already.
 */
export class Orchestrators {
  readonly debates: DebateRunner;
  readonly crews: CrewRunner;

  constructor(manager: SessionManager, broadcast: (event: ServerEvent) => void) {
    this.debates = new DebateRunner(manager, (debate) => broadcast({ type: 'debate', debate }));
    this.crews = new CrewRunner(manager, (crew) => broadcast({ type: 'crew', crew }));
  }

  /**
   * Sessions a run still needs, which the idle-stop must leave alone.
   *
   * Observed live before this existed: both sides of a debate were stopped
   * between the critique and the answer because no browser had been open for
   * thirty seconds, and the run reported that the author had said nothing.
   */
  activeSessionIds(): Set<string> {
    const ids = this.debates.activeSessionIds();
    for (const id of this.crews.activeSessionIds()) ids.add(id);
    return ids;
  }

  /** A parked `canUseTool` produces no other signal, so every update is read. */
  onSessionUpdate(summary: SessionSummary): void {
    this.debates.onSessionUpdate(summary);
    this.crews.onSessionUpdate(summary);
  }

  /**
   * Everything a browser that just connected has missed.
   *
   * A run outlives the socket that asked for it — that is the entire point of
   * starting one and walking away — so without this a reload shows an empty
   * panel while two agents are still arguing behind it.
   */
  replay(send: (event: ServerEvent) => void): void {
    for (const debate of this.debates.list()) send({ type: 'debate', debate });
    for (const crew of this.crews.list()) send({ type: 'crew', crew });
  }

  /** Returns false for anything it does not own, so the caller's switch carries on. */
  handle(cmd: ClientCommand): boolean {
    switch (cmd.type) {
      case 'start_debate':
        this.debates.start(cmd);
        return true;
      case 'start_crew':
        this.crews.start(cmd);
        return true;
      default:
        return false;
    }
  }
}
