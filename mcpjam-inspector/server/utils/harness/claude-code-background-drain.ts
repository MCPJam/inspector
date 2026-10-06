/**
 * Group D: background drain for the Claude Code bridge.
 *
 * The vendored bridge (`@ai-sdk/harness-claude-code@1.0.121`,
 * `dist/bridge/index.mjs`) ends every turn at the CLI's FIRST `result`: two
 * `break`s, then `queryInput.close()` and `q.return()` in its `finally`. That
 * kills any work the model sent to the background. A subagent started with
 * `run_in_background` (or auto-backgrounded by the CLI, which 2.1.245 does to
 * every `Agent` call) never reports back. The model has already told the user
 * "I'll let you know when it's ready", and the answer never reaches the chat.
 *
 * Worse, the next turn's resumed CLI first reports the killed task with an
 * EMPTY `result`, and the unpatched bridge ends that turn on it, before the
 * model has answered the user. So a killed background task breaks the next
 * turn too. (This was the second half of the incident #5944 stopped by
 * setting `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.)
 *
 * Harbor's Claude Code agent has neither problem: it runs one
 * `claude --print` per turn and waits for the process to EXIT, and the CLI
 * does not exit while background agents are pending. This patch gives the
 * bridge the same shape inside one turn:
 *
 *   1. STALE RESULTS. This turn's prompt carries a known uuid, and the CLI
 *      stamps it on the prompt's result (`user_message_uuid`). Before the
 *      first answer, a result stamped with another uuid, or arriving while
 *      the prompt is still `queued`, is forwarded as nothing: the CLI's report
 *      of a task the previous turn killed. So is that stale turn's own
 *      main-thread output while the prompt is `queued`, which would otherwise
 *      run into this turn's answer. Without a stamp, an empty success
 *      before any main-thread message of this prompt is skipped too. If
 *      nothing of the prompt follows a skipped result after 15 s of silence,
 *      the turn ends as the vendor bridge would have ended it. Only this
 *      prompt's own lifecycle or output disarms that backstop; any other
 *      message restarts it, and it holds while the CLI reports itself
 *      `compacting` or `requesting`.
 *   2. WHAT TO WAIT FOR. The pending set is the latest
 *      `system/background_tasks_changed` list (REPLACE semantics, per the SDK)
 *      filtered to `local_agent` and `local_workflow`. Shells, Monitor and
 *      anything unknown are never waited for, so a turn without background
 *      agents ends exactly where it does today.
 *   3. ENDING THE TURN. One decision replaces the two `break`s. Input stays
 *      OPEN (closing it makes the CLI auto-deny permission requests and fail
 *      in-process host tools) while an agent is pending, while a waited-for
 *      task has settled and no main-thread turn has started since
 *      (`system/init` starts every follow-up turn), or while a follow-up turn
 *      is in progress.
 *   4. IDLE GRACE. When the only reason to wait is a settled task whose
 *      follow-up has not started, a 15 s timer (reset by main-thread messages)
 *      closes input and lets the CLI exit.
 *   5. APPROVALS. A request that needs approval from a BACKGROUND agent
 *      (`canUseTool` `options.agentID` names one) is denied, at the vendor's
 *      own decision point: a turn is only ever paused for approval by the
 *      main thread. Foreground subagents carry an `agentID` too, so
 *      membership decides, not presence. A NESTED agent reports
 *      `is_backgrounded: false` even inside a background agent, so its
 *      spawning tool call is traced up through `parent_tool_use_id`: under a
 *      background task it is background, otherwise foreground at any depth.
 *      An agent no task_started names (a workflow's) is background only while
 *      an agent or workflow is pending: a background shell alone never makes
 *      a foreground subagent's request a denial. A main-thread approval
 *      suspends the server request and revokes its model lease, so the
 *      background work still pending is stopped (and reported), and the cap
 *      is paused until the approval is answered. The server suspends by
 *      DETACHING from the bridge, so a detach mid-turn is treated the same
 *      way whatever caused it (a host tool's approval, a scope step-up), and
 *      the continuation's reattach ends the pause with a new lease. Background
 *      tasks only run on `allow-all` turns (`registry.ts`), where a pause is
 *      rare.
 *   6. CAP. `min(drainStart + 10 min, leaseStart + 25 min)`: the model broker
 *      lease is 30 min from the request's start with no renewal, and an
 *      approval's continuation is a new request with a new lease. At the cap the
 *      pending agents are stopped (`stopTask`), input closes, and 15 s later
 *      the CLI is aborted. Every early exit closes open blocks and the open
 *      step before the bridge's normal `finish`.
 *   7. SEVERAL RESULTS IN ONE TURN. Cost is the LATEST `total_cost_usd` (it
 *      is cumulative per process); `observedTerminalError` and Group B's
 *      `streamedAssistantText` reset after each result; a background task's
 *      failure is a notice; once the drain is engaged a terminal error is a
 *      notice plus a normal finish; user-message content is guarded with
 *      `Array.isArray`.
 *   8. NOTICES go out as `raw` parts (`{ mcpjam: "background-task" … }` and
 *      `{ mcpjam: "drain-notice", reason }`), never as bridge warnings, which
 *      only reach the bridge's stderr. A raw part does NOT open the bridge's
 *      step: the agent accepts `finish-step → raw → finish`, and an empty
 *      trailing step would make the turn's final text empty.
 *
 * Nothing outlives the turn: the lease, the computer reservation, the
 * transcript commit, the reaper and resume-from-disk all stay turn-scoped.
 *
 * Background tasks run on `allow-all` turns only (`registry.ts`). Every other
 * mode sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so no agent or shell runs
 * in the background there and the drain never engages; the one exception is
 * the `Workflow` tool, which the CLI always runs in the background.
 *
 * Every needle is quoted VERBATIM from 1.0.121, except the Group B result
 * fallback (this module's own earlier output). None of them touches the
 * regex anchors of the hosted typed-errors patch
 * (`claude-code-typed-errors.ts`); `registry.test.ts` pins that the hosted
 * bridge takes both.
 */

/** Present once Group D is applied; also the bake sentinel. */
export const CLAUDE_CODE_BACKGROUND_DRAIN_MARKER =
  "mcpjamBackgroundDrainReducer";

const BLOCK_BEGIN = "/* mcpjam-background-drain:begin */";
const BLOCK_END = "/* mcpjam-background-drain:end */";

/**
 * Module-level helpers, inserted ahead of the bridge's `addUsage`. Kept
 * self-contained between the begin/end comments (it calls nothing of the
 * bridge's but `emitFinishStep`, and only from `mcpjamCloseOpenStep`) so the
 * tests can lift it out of the installed, patched bridge with `new Function`.
 *
 * Plain JavaScript in a template literal: no backticks, no `${`.
 */
const DRAIN_HELPERS = `${BLOCK_BEGIN}
var MCPJAM_DRAIN_WAIT_TASK_TYPES = /* @__PURE__ */ new Set(["local_agent", "local_workflow"]);
var MCPJAM_DRAIN_IDLE_MS = 15e3;
var MCPJAM_DRAIN_MAX_MS = 6e5;
var MCPJAM_DRAIN_TURN_MAX_MS = 15e5;
var MCPJAM_DRAIN_CAP_GRACE_MS = 15e3;
var MCPJAM_DRAIN_STOP_TASK_TIMEOUT_MS = 2e3;
var MCPJAM_DRAIN_CLASSIFY_WAIT_MS = 1e3;
var MCPJAM_BACKGROUND_APPROVAL_DENIAL = "Background agents can't ask for approval; run this in the foreground.";
var mcpjamHostPresence = { owner: void 0, onDetach: void 0, onAttach: void 0 };
function mcpjamCreateBackgroundDrainState(input) {
  return {
    promptUuid: input.promptUuid,
    turnStartedAt: input.turnStartedAt,
    leaseStartedAt: input.turnStartedAt,
    promptLifecycle: void 0,
    answerStarted: false,
    answered: false,
    succeeded: false,
    drainStartedAt: void 0,
    tasks: /* @__PURE__ */ new Map(),
    backgroundIds: /* @__PURE__ */ new Set(),
    foregroundAgentIds: /* @__PURE__ */ new Set(),
    nestedBackgroundIds: /* @__PURE__ */ new Set(),
    toolUseParents: /* @__PURE__ */ new Map(),
    live: /* @__PURE__ */ new Map(),
    pending: /* @__PURE__ */ new Map(),
    unanswered: /* @__PURE__ */ new Set(),
    answeredTasks: /* @__PURE__ */ new Set(),
    followUpInProgress: false,
    capping: false,
    capped: false
  };
}
function mcpjamDrainTaskMeta(state, taskId, patch) {
  const meta = { ...state.tasks.get(taskId) ?? {} };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== void 0) meta[key] = value;
  }
  state.tasks.set(taskId, meta);
  return meta;
}
function mcpjamDrainSettled(state, taskId) {
  if (!state.answeredTasks.has(taskId)) state.unanswered.add(taskId);
}
function mcpjamDrainUnderBackground(state, toolUseId) {
  let parent = state.toolUseParents.get(toolUseId);
  for (let depth = 0; parent !== void 0 && depth < 16; depth++) {
    for (const [taskId, meta] of state.tasks) {
      if (meta.toolUseId === parent && (state.backgroundIds.has(taskId) || state.nestedBackgroundIds.has(taskId))) return true;
    }
    parent = state.toolUseParents.get(parent);
  }
  return false;
}
function mcpjamDrainIsBackgroundTask(state, taskId) {
  if (state.backgroundIds.has(taskId) || state.nestedBackgroundIds.has(taskId)) return true;
  if (state.tasks.has(taskId)) {
    const toolUseId = state.tasks.get(taskId).toolUseId;
    return toolUseId !== void 0 && mcpjamDrainUnderBackground(state, toolUseId);
  }
  for (const meta of state.pending.values()) {
    if (meta.taskType === "local_workflow") return true;
  }
  return false;
}
function mcpjamDrainAcknowledge(state) {
  for (const taskId of state.unanswered) state.answeredTasks.add(taskId);
  state.unanswered.clear();
}
function mcpjamBackgroundDrainReducer(state, event) {
  const type = event?.type;
  let ignoreResult = false;
  let skip = false;
  let mainThread = false;
  if (type === "command_lifecycle") {
    if (event.command_uuid === state.promptUuid && typeof event.state === "string") {
      state.promptLifecycle = event.state;
      if (event.state === "completed" && !state.answered) {
        state.answerStarted = true;
        state.answered = true;
      }
    }
  } else if (type === "system" && event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
    const live = /* @__PURE__ */ new Map();
    const pending = /* @__PURE__ */ new Map();
    for (const task of event.tasks) {
      if (task == null || typeof task.task_id !== "string") continue;
      const meta = mcpjamDrainTaskMeta(state, task.task_id, {
        taskType: typeof task.task_type === "string" ? task.task_type : void 0,
        description: typeof task.description === "string" ? task.description : void 0
      });
      state.backgroundIds.add(task.task_id);
      state.foregroundAgentIds.delete(task.task_id);
      live.set(task.task_id, meta);
      if (MCPJAM_DRAIN_WAIT_TASK_TYPES.has(meta.taskType)) {
        pending.set(task.task_id, meta);
        state.answeredTasks.delete(task.task_id);
      }
    }
    for (const taskId of state.pending.keys()) {
      if (!pending.has(taskId)) mcpjamDrainSettled(state, taskId);
    }
    state.live = live;
    state.pending = pending;
  } else if (type === "system" && event.subtype === "task_started" && typeof event.task_id === "string") {
    const meta = mcpjamDrainTaskMeta(state, event.task_id, {
      taskType: typeof event.task_type === "string" ? event.task_type : void 0,
      description: typeof event.description === "string" ? event.description : void 0,
      subagentType: typeof event.subagent_type === "string" ? event.subagent_type : void 0,
      toolUseId: typeof event.tool_use_id === "string" ? event.tool_use_id : void 0
    });
    if (event.is_backgrounded === true) {
      state.backgroundIds.add(event.task_id);
      state.foregroundAgentIds.delete(event.task_id);
      state.answeredTasks.delete(event.task_id);
    } else if (meta.taskType === "local_agent" && !state.backgroundIds.has(event.task_id)) {
      if (meta.toolUseId !== void 0 && mcpjamDrainUnderBackground(state, meta.toolUseId)) {
        state.nestedBackgroundIds.add(event.task_id);
      } else {
        state.foregroundAgentIds.add(event.task_id);
      }
    }
  } else if (type === "system" && event.subtype === "task_updated" && typeof event.task_id === "string") {
    if (event.patch?.is_backgrounded === true) {
      state.backgroundIds.add(event.task_id);
      state.foregroundAgentIds.delete(event.task_id);
    }
  } else if (type === "system" && event.subtype === "task_notification" && typeof event.task_id === "string") {
    const meta = mcpjamDrainTaskMeta(state, event.task_id, {
      toolUseId: typeof event.tool_use_id === "string" ? event.tool_use_id : void 0
    });
    if (state.backgroundIds.has(event.task_id) && MCPJAM_DRAIN_WAIT_TASK_TYPES.has(meta.taskType)) {
      mcpjamDrainSettled(state, event.task_id);
    }
  } else if (type === "system" && event.subtype === "init" && event.parent_tool_use_id == null) {
    mainThread = true;
    if (state.answered) {
      state.followUpInProgress = true;
      mcpjamDrainAcknowledge(state);
    }
  } else if ((type === "assistant" || type === "stream_event") && event.parent_tool_use_id == null) {
    mainThread = true;
    if (!state.answered && state.promptLifecycle === "queued") skip = true;
    else state.answerStarted = true;
    if (state.answered) state.followUpInProgress = true;
  } else if (type === "assistant" && event.parent_tool_use_id != null && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        state.toolUseParents.set(block.id, event.parent_tool_use_id);
      }
    }
  } else if (type === "result") {
    mainThread = true;
    if (!state.answered) {
      if (typeof event.user_message_uuid === "string") {
        ignoreResult = event.user_message_uuid !== state.promptUuid;
      } else if (state.promptLifecycle === "queued") {
        ignoreResult = true;
      } else if (!state.answerStarted && event.subtype === "success" && !event.is_error && !(typeof event.result === "string" && event.result.trim())) {
        ignoreResult = true;
      }
    }
  } else if (type === "mcpjam-answer") {
    state.answerStarted = true;
    state.answered = true;
    state.succeeded = true;
    state.followUpInProgress = false;
  } else if (type === "mcpjam-stale-timeout") {
    if (!state.answered) {
      state.answerStarted = true;
      state.answered = true;
    }
  } else if (type === "mcpjam-idle") {
    if (state.pending.size === 0 && !state.followUpInProgress) mcpjamDrainAcknowledge(state);
  } else if (type === "mcpjam-cap") {
    state.capping = true;
  } else if (type === "mcpjam-cap-grace") {
    state.capped = true;
  }
  const keepReading = !state.capped && (!state.answered || state.pending.size > 0 || state.unanswered.size > 0 || state.followUpInProgress);
  if (type === "mcpjam-answer" && keepReading && state.drainStartedAt === void 0) {
    state.drainStartedAt = typeof event.at === "number" ? event.at : state.turnStartedAt;
  }
  return {
    keepReading,
    closeInput: !keepReading,
    abort: type === "mcpjam-cap-grace",
    ignoreResult,
    skip,
    mainThread,
    wantsIdle: state.answered && keepReading && !state.capping && state.pending.size === 0 && !state.followUpInProgress && state.unanswered.size > 0
  };
}
function mcpjamDrainDeadline(state, pausedMs = 0) {
  if (state.drainStartedAt === void 0) return void 0;
  return Math.min(state.drainStartedAt + MCPJAM_DRAIN_MAX_MS + pausedMs, state.leaseStartedAt + MCPJAM_DRAIN_TURN_MAX_MS);
}
function mcpjamCreateBackgroundDrainController(deps) {
  const state = deps.state;
  const now = deps.now ?? (() => Date.now());
  let idleTimer;
  let capTimer;
  let graceTimer;
  let staleTimer;
  let stalePending = false;
  let cliBusy = false;
  let phase;
  const classifyWaiters = /* @__PURE__ */ new Map();
  let approvals = 0;
  let hostDetached = false;
  let pausedSince;
  let pausedMs = 0;
  let stopped = false;
  let touched = false;
  const raw = (rawValue) => {
    touched = true;
    deps.emit({ type: "raw", rawValue });
  };
  const notice = (reason) => raw({ mcpjam: "drain-notice", reason });
  const announced = /* @__PURE__ */ new Set();
  const progress = (taskId, status) => {
    if (status === "running") {
      if (announced.has(taskId)) return;
      announced.add(taskId);
    }
    const meta = state.tasks.get(taskId) ?? {};
    raw({
      mcpjam: "background-task",
      taskId,
      ...meta.toolUseId !== void 0 ? { toolUseId: meta.toolUseId } : {},
      status,
      ...meta.description !== void 0 ? { description: meta.description } : {},
      ...meta.subagentType !== void 0 ? { subagentType: meta.subagentType } : {},
      ...meta.taskType !== void 0 ? { taskType: meta.taskType } : {}
    });
  };
  const clearIdle = () => {
    if (idleTimer !== void 0) clearTimeout(idleTimer);
    idleTimer = void 0;
  };
  const clearCap = () => {
    if (capTimer !== void 0) clearTimeout(capTimer);
    capTimer = void 0;
  };
  const clearStale = () => {
    if (staleTimer !== void 0) clearTimeout(staleTimer);
    staleTimer = void 0;
  };
  const clear = () => {
    clearIdle();
    clearCap();
    clearStale();
    if (graceTimer !== void 0) clearTimeout(graceTimer);
    graceTimer = void 0;
    if (mcpjamHostPresence.owner === controller) {
      mcpjamHostPresence.onDetach = void 0;
      mcpjamHostPresence.onAttach = void 0;
      mcpjamHostPresence.owner = void 0;
    }
  };
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    clear();
    if (reason) notice(reason);
    deps.closeOpenStep();
    deps.closeInput();
    deps.abort();
  };
  const onIdle = () => {
    idleTimer = void 0;
    if (stopped) return;
    const step = mcpjamBackgroundDrainReducer(state, { type: "mcpjam-idle" });
    if (!step.keepReading && !deps.hasActiveUserMessages()) {
      notice("idle");
      deps.closeInput();
      return;
    }
    sync(step);
  };
  const onGrace = () => {
    graceTimer = void 0;
    mcpjamBackgroundDrainReducer(state, { type: "mcpjam-cap-grace" });
    stop();
  };
  const onCap = () => {
    capTimer = void 0;
    if (stopped || state.capping) return;
    if (approvals > 0) return;
    mcpjamBackgroundDrainReducer(state, { type: "mcpjam-cap" });
    clearIdle();
    notice("cap");
    const taskIds = [...state.pending.keys()];
    let stopTimeout;
    const stopping = Promise.allSettled(
      taskIds.map((taskId) => Promise.resolve().then(() => deps.stopTask(taskId)))
    );
    void Promise.race([
      stopping,
      new Promise((resolve) => {
        stopTimeout = setTimeout(resolve, MCPJAM_DRAIN_STOP_TASK_TIMEOUT_MS);
        stopTimeout.unref?.();
      })
    ]).then(() => {
      clearTimeout(stopTimeout);
      if (!stopped) deps.closeInput();
    });
    graceTimer = setTimeout(onGrace, MCPJAM_DRAIN_CAP_GRACE_MS);
    graceTimer.unref?.();
  };
  const armCap = () => {
    const deadline = mcpjamDrainDeadline(state, pausedMs);
    if (deadline === void 0 || stopped || state.capping) return;
    clearCap();
    capTimer = setTimeout(onCap, Math.max(0, deadline - now()));
    capTimer.unref?.();
  };
  // The server keeps the delivered answer on a Stop only while the bridge is
  // WAITING (nothing streaming, no tool in flight). Announced on every change
  // and again when an approval resumes the turn in a new server request.
  const announcePhase = (force) => {
    if (stopped || state.drainStartedAt === void 0) return;
    const next = state.followUpInProgress ? "follow-up" : "draining";
    if (next === phase && !force) return;
    phase = next;
    notice(next);
  };
  const isClassified = (agentID) => state.backgroundIds.has(agentID) || state.nestedBackgroundIds.has(agentID) || state.foregroundAgentIds.has(agentID);
  const flushClassifyWaiters = () => {
    for (const [agentID, waiters] of classifyWaiters) {
      if (!isClassified(agentID)) continue;
      classifyWaiters.delete(agentID);
      for (const wake of waiters) wake();
    }
  };
  const armStale = (extraMs = 0) => {
    clearStale();
    if (!stalePending || stopped || cliBusy) return;
    staleTimer = setTimeout(onStaleTimeout, MCPJAM_DRAIN_IDLE_MS + extraMs);
    staleTimer.unref?.();
  };
  const onStaleTimeout = () => {
    staleTimer = void 0;
    stalePending = false;
    if (stopped) return;
    const step = mcpjamBackgroundDrainReducer(state, { type: "mcpjam-stale-timeout" });
    if (!step.keepReading && !deps.hasActiveUserMessages()) {
      notice("no answer after a skipped result");
      deps.closeInput();
    }
  };
  const sync = (step) => {
    if (stopped) return;
    if (step.keepReading) announcePhase(false);
    if (step.wantsIdle) {
      if (idleTimer === void 0 || step.mainThread) {
        clearIdle();
        idleTimer = setTimeout(onIdle, MCPJAM_DRAIN_IDLE_MS);
        idleTimer.unref?.();
      }
    } else {
      clearIdle();
    }
    if (capTimer === void 0 && approvals === 0) armCap();
  };
  const controller = {
    state,
    get stopped() {
      return stopped;
    },
    get touched() {
      return touched;
    },
    get draining() {
      return state.drainStartedAt !== void 0 && !stopped;
    },
    get waiting() {
      return state.drainStartedAt !== void 0 && !stopped && !state.followUpInProgress;
    },
    observe(msg) {
      const step = mcpjamBackgroundDrainReducer(state, msg);
      flushClassifyWaiters();
      // A skipped result must not leave the turn open forever: if nothing of
      // this prompt follows it, end the turn as the vendor bridge would have.
      // Only THIS prompt showing life disarms it; anything else the CLI says
      // is activity that restarts the silence window, and while the CLI
      // reports itself busy (compacting, a request in flight) it never fires.
      if (msg?.type === "system" && msg.subtype === "status") {
        cliBusy = msg.status === "compacting" || msg.status === "requesting";
      }
      if (step.ignoreResult) {
        stalePending = true;
        armStale();
      } else if (stalePending) {
        const promptAlive =
          (msg?.type === "command_lifecycle" && msg.command_uuid === state.promptUuid && msg.state !== "queued") ||
          (step.mainThread && !step.skip && msg?.type !== "result" && state.promptLifecycle !== "queued");
        if (promptAlive) {
          stalePending = false;
          clearStale();
        } else {
          armStale(msg?.type === "system" && msg.subtype === "api_retry" && typeof msg.retry_delay_ms === "number" ? msg.retry_delay_ms : 0);
        }
      }
      if (!stopped && msg?.type === "system" && msg.subtype === "background_tasks_changed") {
        // The level usually precedes task_started; announce a task once both
        // have been seen, so the status carries its tool call and agent type.
        for (const [taskId, meta] of state.live) {
          if (meta.toolUseId !== void 0) progress(taskId, "running");
        }
      } else if (!stopped && msg?.type === "system" && typeof msg.task_id === "string") {
        const taskId = msg.task_id;
        if (msg.subtype === "task_started" && (msg.is_backgrounded === true || state.backgroundIds.has(taskId))) {
          progress(taskId, "running");
        } else if (msg.subtype === "task_updated" && mcpjamDrainIsBackgroundTask(state, taskId)) {
          if (msg.patch?.is_backgrounded === true) progress(taskId, "running");
          if (msg.patch?.status === "failed") {
            notice("background task failed: " + (typeof msg.patch.error === "string" && msg.patch.error ? msg.patch.error : taskId));
          }
        } else if (msg.subtype === "task_notification" && state.backgroundIds.has(taskId)) {
          progress(taskId, typeof msg.status === "string" ? msg.status : "completed");
        }
      }
      sync(step);
      return step;
    },
    answer() {
      stalePending = false;
      clearStale();
      const step = mcpjamBackgroundDrainReducer(state, { type: "mcpjam-answer", at: now() });
      sync(step);
      return step;
    },
    async isBackgroundAgentRequest(agentID) {
      if (typeof agentID !== "string" || agentID.length === 0) return false;
      if (!isClassified(agentID)) {
        // A request can outrun its task_started in the stream; wait for
        // observe() to classify it, bounded.
        await new Promise((resolve) => {
          const waiters = classifyWaiters.get(agentID) ?? [];
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            const left = (classifyWaiters.get(agentID) ?? []).filter((waiter) => waiter !== wake);
            if (left.length > 0) classifyWaiters.set(agentID, left);
            else classifyWaiters.delete(agentID);
            resolve();
          }, MCPJAM_DRAIN_CLASSIFY_WAIT_MS);
          timer.unref?.();
          waiters.push(wake);
          classifyWaiters.set(agentID, waiters);
        });
      }
      if (state.backgroundIds.has(agentID) || state.nestedBackgroundIds.has(agentID)) return true;
      if (state.foregroundAgentIds.has(agentID)) {
        const toolUseId = state.tasks.get(agentID)?.toolUseId;
        return toolUseId !== void 0 && mcpjamDrainUnderBackground(state, toolUseId);
      }
      return state.pending.size > 0;
    },
    // Called at the vendor's own "this needs approval" point, so the gate is
    // exactly the vendor's. Undefined means: ask the user as usual.
    async denyBackgroundApproval(toolName, options) {
      if (!await this.isBackgroundAgentRequest(options?.agentID)) return void 0;
      if (!stopped) notice("denied a background agent's approval request for " + toolName);
      return {
        behavior: "deny",
        message: MCPJAM_BACKGROUND_APPROVAL_DENIAL,
        ...typeof options?.toolUseID === "string" ? { toolUseID: options.toolUseID } : {}
      };
    },
    // Wraps the vendor's wait for a main-thread approval. The server suspends
    // the turn and revokes its model lease while it waits, so background work
    // still pending cannot finish: it is stopped, and reported, rather than
    // left to fail on a missing lease. The continuation is a new request with
    // a new lease, so the turn bound restarts when the approval is answered.
    trackApproval(decision) {
      this.approvalStarted();
      return Promise.resolve(decision).finally(() => this.approvalEnded());
    },
    approvalStarted() {
      if (approvals++ === 0) {
        pausedSince = now();
        clearCap();
        const taskIds = [...state.pending.keys()];
        if (taskIds.length > 0 && !stopped) {
          notice("stopped background work: the turn is paused for approval");
          for (const taskId of taskIds) {
            void Promise.resolve().then(() => deps.stopTask(taskId)).catch(() => {});
          }
        }
      }
    },
    approvalEnded() {
      if (approvals === 0) return;
      if (--approvals === 0) {
        if (pausedSince !== void 0 && state.drainStartedAt !== void 0) {
          pausedMs += Math.max(0, now() - Math.max(pausedSince, state.drainStartedAt));
        }
        pausedSince = void 0;
        state.leaseStartedAt = now();
        announcePhase(true);
        armCap();
      }
    },
    stop,
    clear
  };
  // The server suspends a turn by detaching from the bridge: every approval
  // (native or a host tool's) and every scope step-up pauses that way, and
  // the turn's model lease is revoked while it waits. So a detach mid-turn is
  // a pause like an approval, whatever caused it, and the reattach of the
  // continuation (a new request, with a new lease) ends it.
  mcpjamHostPresence.owner = controller;
  mcpjamHostPresence.onDetach = () => {
    if (stopped || hostDetached) return;
    hostDetached = true;
    controller.approvalStarted();
  };
  mcpjamHostPresence.onAttach = () => {
    if (!hostDetached) return;
    hostDetached = false;
    controller.approvalEnded();
  };
  return controller;
}
function mcpjamCloseOpenStep(state, emit) {
  for (const block of state.partialBlocks.values()) {
    if (block.kind === "text") emit({ type: "text-end", id: block.id });
    else if (block.kind === "thinking") emit({ type: "reasoning-end", id: block.id });
    else emit({ type: "tool-input-end", id: block.id });
  }
  state.partialBlocks.clear();
  if (state.stepOpen) emitFinishStep({ state, emit, usage: state.pendingStepUsage });
}
${BLOCK_END}
`;

type Replacement = readonly [needle: string, replacement: string];

const REPLACEMENTS: readonly Replacement[] = [
  // Module helpers.
  [
    `function addUsage(total, usage) {
  if (total == null) return usage;`,
    `${DRAIN_HELPERS}function addUsage(total, usage) {
  if (total == null) return usage;`,
  ],
  // A Stop while the drain only WAITS ends it at once: open blocks and the
  // step close, the CLI is aborted and the bridge still emits its normal
  // `finish`. Before the drain, or while a follow-up is running, Stop keeps
  // the bridge's graceful interrupt. The controller is declared ahead of the
  // listener, so an abort during setup finds it unset, never uninitialized.
  [
    `  const onHostAbort = () => {
    if (gracefulAbort) {`,
    `  let mcpjamDrainController;
  const onHostAbort = () => {
    if (mcpjamDrainController?.waiting) {
      mcpjamDrainController.stop("stopped");
      return;
    }
    if (gracefulAbort) {`,
  ],
  // The drain state, and the uuid this turn's prompt is sent with.
  [
    `  const streamEventState = createClaudeStreamEventState();`,
    `  const streamEventState = createClaudeStreamEventState();
  const mcpjamDrainState = mcpjamCreateBackgroundDrainState({
    promptUuid: randomUUID3(),
    turnStartedAt: Date.now()
  });
  streamEventState.mcpjamDrain = mcpjamDrainState;`,
  ],
  [
    `  const queryInput = createQueryInput({
    initialUserMessage: start.prompt,`,
    `  const queryInput = createQueryInput({
    initialUserMessage: start.prompt,
    initialMessageId: mcpjamDrainState.promptUuid,`,
  ],
  [
    `function createQueryInput({
  initialUserMessage,`,
    `function createQueryInput({
  initialUserMessage,
  initialMessageId,`,
  ],
  [
    `                  text: initialUserMessage,
                  messageId: randomUUID3()`,
    `                  text: initialUserMessage,
                  messageId: initialMessageId ?? randomUUID3()`,
  ],
  // The host's socket closing mid-turn, or reattaching to resume it.
  [
    `      case "resume":
        activeSocket = ws;`,
    `      case "resume":
        activeSocket = ws;
        mcpjamHostPresence.onAttach?.();`,
  ],
  [
    `    ws.on("close", () => {
      if (activeSocket === ws) {
        activeSocket = void 0;`,
    `    ws.on("close", () => {
      if (activeSocket === ws) {
        activeSocket = void 0;
        mcpjamHostPresence.onDetach?.();`,
  ],
  // The controller (timers, notices, approvals). `q` is read lazily.
  [
    `  const skillsOption = toClaudeSkillsOption(start.skills);`,
    `  mcpjamDrainController = mcpjamCreateBackgroundDrainController({
    state: mcpjamDrainState,
    emit,
    stopTask: (taskId) => q.stopTask(taskId),
    closeInput: () => queryInput.close(),
    abort: () => abortCtl.abort(),
    closeOpenStep: () => mcpjamCloseOpenStep(streamEventState, emit),
    hasActiveUserMessages: () => queryInput.hasActiveUserMessages()
  });
  const skillsOption = toClaudeSkillsOption(start.skills);`,
  ],
  // Approvals, at the vendor's own decision point so its gate stays the only
  // gate: a background agent's request is denied before the approval events
  // are emitted, and the wait for a main-thread decision is tracked.
  [
    `      const approvalId = options.toolUseID;
      input.approvalRequestedToolUseIds.add(approvalId);`,
    `      const mcpjamDenial = await input.mcpjamDenyBackgroundApproval?.(toolName, options);
      if (mcpjamDenial) return mcpjamDenial;
      const approvalId = options.toolUseID;
      input.approvalRequestedToolUseIds.add(approvalId);`,
  ],
  [
    `      const decision = await input.turn.requestToolApproval(approvalId);`,
    `      const decision = await (input.mcpjamRequestToolApproval ? input.mcpjamRequestToolApproval(approvalId) : input.turn.requestToolApproval(approvalId));`,
  ],
  [
    `  const permissionOptions = createPermissionOptions({
    start,`,
    `  const permissionOptions = createPermissionOptions({
    start,
    mcpjamDenyBackgroundApproval: (toolName, options) => mcpjamDrainController.denyBackgroundApproval(toolName, options),
    mcpjamRequestToolApproval: (approvalId) => mcpjamDrainController.trackApproval(turn.requestToolApproval(approvalId)),`,
  ],
  // Once the drain is engaged, a terminal error is a notice plus a normal
  // finish: the answer the user already has stays theirs. Gated on the drain,
  // not on the first answer, so a turn kept open only by steering messages
  // still reports its errors.
  [
    `    if (!normalized || emittedTerminalError || emittedTerminalFinish) return;
    streamEventState.observedTerminalError = normalized;`,
    `    if (!normalized || emittedTerminalError || emittedTerminalFinish) return;
    if (mcpjamDrainState.drainStartedAt !== void 0) {
      mcpjamDrainController.stop("error after the answer: " + normalized);
      return;
    }
    streamEventState.observedTerminalError = normalized;`,
  ],
  // `total_cost_usd` is cumulative per CLI process: take the latest.
  [
    `            totalCostUsd = (totalCostUsd ?? 0) + msg.total_cost_usd;`,
    `            totalCostUsd = msg.total_cost_usd;`,
  ],
  // Observe every message; a stale result is forwarded as nothing.
  [
    `      emitStreamEvent(msg);
      if (type === "result") {`,
    `      const mcpjamDrainStep = mcpjamDrainController.observe(msg);
      if (mcpjamDrainStep.ignoreResult || mcpjamDrainStep.skip) continue;
      emitStreamEvent(msg);
      if (type === "result") {`,
  ],
  // The first `break`: an answer ends the turn unless the drain keeps it open.
  [
    `          queryInput.observeResult();
          if (!queryInput.hasActiveUserMessages()) {
            queryInput.close();
            break;
          }`,
    `          queryInput.observeResult();
          streamEventState.observedTerminalError = void 0;
          const mcpjamAnswer = mcpjamDrainController.answer();
          if (!mcpjamAnswer.keepReading && !queryInput.hasActiveUserMessages()) {
            queryInput.close();
            break;
          }`,
  ],
  // The second `break`.
  [
    `      if (queryInput.hasObservedResult && !queryInput.hasActiveUserMessages()) {`,
    `      if ((queryInput.hasObservedResult || mcpjamDrainState.answered) && !mcpjamDrainStep.keepReading && !queryInput.hasActiveUserMessages()) {`,
  ],
  // A drain the bridge stopped itself (cap, Stop, a downgraded error) falls
  // through to the normal `finish`.
  [
    `    if (!turn.abortSignal.aborted && !(abortCtl.signal.aborted && emittedTerminalError)) {
      turn.emitError({ error: err, message: "claude-code turn failed" });
    }
    return;
  } finally {
    gracefulAbort = void 0;`,
    `    if (!mcpjamDrainController.stopped) {
      if (!turn.abortSignal.aborted && !(abortCtl.signal.aborted && emittedTerminalError)) {
        turn.emitError({ error: err, message: "claude-code turn failed" });
      }
      return;
    }
  } finally {
    mcpjamDrainController.clear();
    gracefulAbort = void 0;`,
  ],
  // A background task's failure is the controller's notice, not the turn's.
  [
    `    if (type === "system" && msg.subtype === "task_updated" && msg.patch?.status === "failed" && typeof msg.patch.error === "string") {
      emitTerminalError(msg.patch.error);`,
    `    if (type === "system" && msg.subtype === "task_updated" && msg.patch?.status === "failed" && typeof msg.patch.error === "string") {
      if (state.mcpjamDrain && mcpjamDrainIsBackgroundTask(state.mcpjamDrain, msg.task_id)) return;
      emitTerminalError(msg.patch.error);`,
  ],
  [
    `    if (type === "user" && msg.message?.content) {`,
    `    if (type === "user" && Array.isArray(msg.message?.content)) {`,
  ],
  // Group B's result fallback (this module's own earlier output): a follow-up
  // answer that is not streamed must not be suppressed by turn 1's stream.
  [
    `    if (type === "result" && msg.subtype === "success") {
      emitAssistantTextFallback(msg.result);
    }`,
    `    if (type === "result" && msg.subtype === "success") {
      emitAssistantTextFallback(msg.result);
    }
    if (type === "result") {
      streamedAssistantText = false;
      lastEmittedFallbackText = void 0;
    }`,
  ],
];

/** Every needle Group D matches, for fixtures that must quote them. */
export const CLAUDE_CODE_BACKGROUND_DRAIN_NEEDLES: readonly string[] =
  REPLACEMENTS.map(([needle]) => needle);

/**
 * Apply Group D. Idempotent on {@link CLAUDE_CODE_BACKGROUND_DRAIN_MARKER};
 * throws on any missing or ambiguous needle rather than ship a half-patched
 * turn loop.
 */
export function patchClaudeCodeBackgroundDrain(content: string): string {
  if (content.includes(CLAUDE_CODE_BACKGROUND_DRAIN_MARKER)) return content;
  let patched = content;
  for (const [needle, replacement] of REPLACEMENTS) {
    const at = patched.indexOf(needle);
    if (at < 0 || patched.indexOf(needle, at + needle.length) >= 0) {
      throw new Error(
        "Unable to patch Claude Code bridge bootstrap: turn loop shape changed",
      );
    }
    patched =
      patched.slice(0, at) + replacement + patched.slice(at + needle.length);
  }
  return patched;
}

/**
 * The self-contained helper block of a patched bridge, for tests that lift
 * the reducer and controller out of the INSTALLED bridge.
 */
export function extractClaudeCodeBackgroundDrainHelpers(
  content: string,
): string | undefined {
  const begin = content.indexOf(BLOCK_BEGIN);
  const end = content.indexOf(BLOCK_END);
  if (begin < 0 || end < begin) return undefined;
  return content.slice(begin, end + BLOCK_END.length);
}
