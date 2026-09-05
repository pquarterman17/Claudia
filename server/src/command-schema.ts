/**
 * Runtime validation for every ClientCommand the gateway accepts from a
 * socket. Replaces `JSON.parse(...) as ClientCommand` in gateway.ts, which
 * cast rather than checked — any browser tab or local process that can
 * reach the port could send a malformed or hostile object and it flowed
 * straight into dispatch().
 *
 * One case per member of the ClientCommand union in shared/src/protocol.ts,
 * enumerated by hand rather than derived from the type. Deriving checks
 * from the same type they exist to police would let a mistake in the union
 * and a mistake in the checker cancel each other out silently; hand-written
 * cases fail loudly (a missing `case` falls through to "unknown command
 * type") the moment the two drift apart.
 */
import { TASK_TRANSITIONS, type ClientCommand } from '@claudia/shared';
import {
  answersField, field, imagesField, isAgentKind, isBool, isBulkOp, isDebateSubject, isDirection,
  isEffortLevel, isFinishAction, isLabel, isNullableLabel, isNum, isPermissionMode, isPlainObject,
  isPlanTier, isText, isThinkingMode, runChecks, scanStructure, templateField, toolkitActionField,
  truncateForLog, workersField,
} from './command-fields.js';

export type ParseResult = { ok: true; cmd: ClientCommand } | { ok: false; reason: string };

const isMissionWatch = (v: unknown): boolean => v === 'watching' || v === 'paused';
/** Checked against the union the store enforces, so the two cannot drift. */
const TASK_STATUSES: readonly string[] = Object.keys(TASK_TRANSITIONS);
const isTaskStatus = (v: unknown): boolean => typeof v === 'string' && TASK_STATUSES.includes(v);
const isSeq = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isLabelList = (v: unknown): boolean => Array.isArray(v) && v.every((item) => isLabel(item));

const req = (key: string, test: (v: unknown) => boolean, what: string) => field(key, true, test, what);
const opt = (key: string, test: (v: unknown) => boolean, what: string) => field(key, false, test, what);

export function parseCommand(raw: unknown): ParseResult {
  if (!isPlainObject(raw)) return { ok: false, reason: 'command must be a JSON object' };
  const structural = scanStructure(raw);
  if (structural) return { ok: false, reason: structural };
  if (typeof raw.type !== 'string') return { ok: false, reason: 'command has no string "type"' };

  const reason = validate(raw.type, raw);
  // validate() checks every field the matching ClientCommand member
  // declares, keyed off the same literal type tags the union itself
  // switches on — once it returns clean, `raw` has been proven to match
  // that member, which is what makes this final cast safe rather than a cast.
  return reason ? { ok: false, reason } : { ok: true, cmd: raw as ClientCommand };
}

function validate(type: string, o: Record<string, unknown>): string | undefined {
  switch (type) {
    case 'launch_session':
      return runChecks(type, o, [
        req('cwd', isLabel, 'a string'),
        opt('agent', isAgentKind, 'a known agent kind'),
        opt('worktreeBranch', isLabel, 'a string'),
        opt('prompt', isText, 'a string'),
        opt('model', isLabel, 'a string'),
        opt('permissionMode', isPermissionMode, 'a known permission mode'),
        opt('effortLevel', isEffortLevel, 'a known effort level'),
        opt('thinkingMode', isThinkingMode, 'a known thinking mode'),
      ]);
    case 'list_saved_sessions':
      return runChecks(type, o, [opt('cwd', isLabel, 'a string')]);
    case 'get_saved_session_detail':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), opt('cwd', isLabel, 'a string')]);
    case 'resume_saved_session':
    case 'fork_saved_session':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        req('cwd', isLabel, 'a string'),
        opt('agent', isAgentKind, 'a known agent kind'),
        opt('permissionMode', isPermissionMode, 'a known permission mode'),
      ]);
    case 'rename_saved_session':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        opt('cwd', isLabel, 'a string'),
        req('title', isLabel, 'a string'),
      ]);
    case 'tag_saved_session':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        opt('cwd', isLabel, 'a string'),
        req('tag', isNullableLabel, 'a string or null'),
      ]);
    case 'rewind_files':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('checkpointId', isLabel, 'a string')]);
    case 'send_prompt':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('text', isText, 'a string'), imagesField]);
    case 'approve':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('requestId', isLabel, 'a string')]);
    case 'deny':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        req('requestId', isLabel, 'a string'),
        opt('message', isText, 'a string'),
      ]);
    case 'always_allow_project':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('requestId', isLabel, 'a string')]);
    case 'answer_question':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        req('requestId', isLabel, 'a string'),
        answersField,
      ]);
    // These ten all take nothing but the session they act on.
    case 'interrupt':
    case 'stop_session':
    case 'remove_session':
    case 'fetch_real_usage':
    case 'refresh_context':
    case 'get_models':
    case 'get_commands':
    case 'get_mcp_status':
    case 'get_effective_settings':
    case 'get_transcript':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string')]);
    // These five carry no fields at all beyond `type`.
    case 'browse_folder':
    case 'require_approvals_everywhere':
    case 'clear_finish_chain':
    case 'disarm_trigger':
    case 'ping':
      return undefined;
    // The mission layer. Hand-written like every other case here, for the
    // reason at the top of this file: a checker derived from the union it
    // polices lets one mistake cancel the other out.
    case 'create_mission':
      return runChecks(type, o, [
        req('name', isLabel, 'a string'),
        req('body', isText, 'a string'),
        req('cwd', isLabel, 'a string'),
      ]);
    case 'list_missions':
      return runChecks(type, o, []);
    case 'set_mission_watch':
      return runChecks(type, o, [
        req('missionId', isLabel, 'a string'),
        req('watch', isMissionWatch, 'watching or paused'),
      ]);
    case 'create_task':
      return runChecks(type, o, [
        req('missionId', isLabel, 'a string'),
        req('title', isLabel, 'a string'),
        req('description', isText, 'a string'),
        req('cwd', isLabel, 'a string'),
        opt('dependsOn', isLabelList, 'an array of task ids'),
      ]);
    case 'list_tasks':
      return runChecks(type, o, [req('missionId', isLabel, 'a string')]);
    case 'set_task_status':
      return runChecks(type, o, [
        req('missionId', isLabel, 'a string'),
        req('taskId', isLabel, 'a string'),
        req('status', isTaskStatus, 'a known task status'),
      ]);
    case 'get_fleet_events':
      return runChecks(type, o, [
        req('missionId', isLabel, 'a string'),
        // A cursor, so it has to be a whole number that is not negative — a
        // fractional or negative one would silently widen the window rather
        // than fail, which is the shape of bug this validation exists for.
        opt('afterSeq', isSeq, 'a non-negative whole number'),
      ]);
    case 'set_permission_mode':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        req('mode', isPermissionMode, 'a known permission mode'),
      ]);
    case 'toggle_finish_action':
      return runChecks(type, o, [req('action', isFinishAction, 'a known finish action')]);
    case 'move_finish_action':
      return runChecks(type, o, [
        req('action', isFinishAction, 'a known finish action'),
        req('direction', isDirection, '"up" or "down"'),
      ]);
    case 'arm_trigger':
      return runChecks(type, o, [opt('confirmDestructive', isBool, 'a boolean')]);
    case 'bulk':
      return runChecks(type, o, [req('op', isBulkOp, 'a known bulk op')]);
    case 'set_plan_tier':
      return runChecks(type, o, [req('tier', isPlanTier, 'a known plan tier')]);
    case 'set_custom_ceilings':
      return runChecks(type, o, [req('sessionTokens', isNum, 'a number'), req('weeklyTokens', isNum, 'a number')]);
    case 'set_countdown':
    case 'set_stop_on_close':
      return runChecks(type, o, [req('seconds', isNum, 'a number')]);
    case 'rename_session':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('title', isLabel, 'a string')]);
    case 'set_model':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('model', isLabel, 'a string')]);
    case 'set_effort':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        req('effortLevel', isEffortLevel, 'a known effort level'),
      ]);
    case 'set_thinking':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        req('thinkingMode', isThinkingMode, 'a known thinking mode'),
      ]);
    case 'reconnect_mcp':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('serverName', isLabel, 'a string')]);
    case 'toggle_mcp':
      return runChecks(type, o, [
        req('sessionId', isLabel, 'a string'),
        req('serverName', isLabel, 'a string'),
        req('enabled', isBool, 'a boolean'),
      ]);
    case 'stop_task':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('taskId', isLabel, 'a string')]);
    case 'save_template':
      return runChecks(type, o, [templateField]);
    case 'set_hook_monitor':
      return runChecks(type, o, [req('enabled', isBool, 'a boolean')]);
    case 'search_files':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('query', isLabel, 'a string')]);
    case 'set_output_style':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('style', isLabel, 'a string')]);
    case 'set_agent':
      return runChecks(type, o, [req('sessionId', isLabel, 'a string'), req('agent', isAgentKind, 'a known agent kind')]);
    case 'start_debate':
      return runChecks(type, o, [
        req('cwd', isLabel, 'a string'),
        req('objective', isText, 'a string'),
        req('subject', isDebateSubject, 'a known debate subject'),
        opt('authorSessionId', isLabel, 'a string'),
        req('author', isAgentKind, 'a known agent kind'),
        req('reviewer', isAgentKind, 'a known agent kind'),
        req('rounds', isNum, 'a number'),
      ]);
    case 'start_crew':
      return runChecks(type, o, [
        req('cwd', isLabel, 'a string'),
        req('objective', isText, 'a string'),
        req('planner', isAgentKind, 'a known agent kind'),
        workersField,
        req('maxTasks', isNum, 'a number'),
      ]);
    case 'save_toolkit_action':
      return runChecks(type, o, [toolkitActionField]);
    case 'delete_toolkit_action':
      return runChecks(type, o, [req('id', isLabel, 'a string')]);
    case 'delete_template':
      return runChecks(type, o, [req('name', isLabel, 'a string')]);
    default:
      return `unknown command type "${truncateForLog(type)}"`;
  }
}
