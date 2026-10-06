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
 *   1. STALE RESULTS. This turn's prompt carries a known uuid. A `result`
 *      counts as this turn's answer only once a main-thread assistant message
 *      has appeared after the CLI STARTED that prompt (`command_lifecycle`
 *      `started` for its uuid). An earlier empty success, the CLI's report of
 *      a task the previous turn killed, is forwarded as nothing.
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
 *      (`canUseTool` `options.agentID` names one) is denied: a turn is only
 *      ever paused for approval by the main thread. Foreground subagents carry
 *      an `agentID` too, so membership decides, not presence. An agent no
 *      task_started names (a workflow's, or one nested in another agent) is
 *      background only while an agent or workflow is pending: a background
 *      shell alone never makes a foreground subagent's request a denial.
 *      Main-thread approvals pause the cap.
 *   6. CAP. `min(drainStart + 10 min, turnStart + 25 min)`: the model broker
 *      lease is 30 min from turn start with no renewal. At the cap the
 *      pending agents are stopped (`stopTask`), input closes, and 15 s later
 *      the CLI is aborted. Every early exit closes open blocks and the open
 *      step before the bridge's normal `finish`.
 *   7. SEVERAL RESULTS IN ONE TURN. Cost is the LATEST `total_cost_usd` (it
 *      is cumulative per process); `observedTerminalError` and Group B's
 *      `streamedAssistantText` reset after each result; a background task's
 *      failure is a notice; after the first successful answer a terminal error
 *      is a notice plus a normal finish; user-message content is guarded with
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
 * With `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` set (#5944) no agent or shell
 * runs in the background, so the drain never engages. The one exception is
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
function mcpjamCreateBackgroundDrainState(input) {
  return {
    promptUuid: input.promptUuid,
    turnStartedAt: input.turnStartedAt,
    promptLifecycle: void 0,
    answerStarted: false,
    answered: false,
    succeeded: false,
    drainStartedAt: void 0,
    tasks: /* @__PURE__ */ new Map(),
    backgroundIds: /* @__PURE__ */ new Set(),
    foregroundAgentIds: /* @__PURE__ */ new Set(),
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
function mcpjamDrainAcknowledge(state) {
  for (const taskId of state.unanswered) state.answeredTasks.add(taskId);
  state.unanswered.clear();
}
function mcpjamBackgroundDrainReducer(state, event) {
  const type = event?.type;
  let ignoreResult = false;
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
      if (MCPJAM_DRAIN_WAIT_TASK_TYPES.has(meta.taskType)) pending.set(task.task_id, meta);
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
    } else if (meta.taskType === "local_agent" && (event.spawn_depth === void 0 || event.spawn_depth === 1) && !state.backgroundIds.has(event.task_id)) {
      state.foregroundAgentIds.add(event.task_id);
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
    if (state.promptLifecycle !== "queued") state.answerStarted = true;
    if (state.answered) state.followUpInProgress = true;
  } else if (type === "result") {
    mainThread = true;
    if (!state.answerStarted && event.subtype === "success" && !event.is_error && !(typeof event.result === "string" && event.result.trim())) {
      ignoreResult = true;
    }
  } else if (type === "mcpjam-answer") {
    state.answerStarted = true;
    state.answered = true;
    state.succeeded = true;
    state.followUpInProgress = false;
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
    mainThread,
    wantsIdle: state.answered && keepReading && !state.capping && state.pending.size === 0 && !state.followUpInProgress && state.unanswered.size > 0
  };
}
function mcpjamDrainDeadline(state) {
  if (state.drainStartedAt === void 0) return void 0;
  return Math.min(state.drainStartedAt + MCPJAM_DRAIN_MAX_MS, state.turnStartedAt + MCPJAM_DRAIN_TURN_MAX_MS);
}
function mcpjamCreateBackgroundDrainController(deps) {
  const state = deps.state;
  const now = deps.now ?? (() => Date.now());
  let idleTimer;
  let capTimer;
  let graceTimer;
  let approvals = 0;
  let pausedSince;
  let pausedMs = 0;
  let stopped = false;
  let touched = false;
  let drainNoticeSent = false;
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
  const clear = () => {
    clearIdle();
    clearCap();
    if (graceTimer !== void 0) clearTimeout(graceTimer);
    graceTimer = void 0;
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
    const deadline = mcpjamDrainDeadline(state);
    if (deadline === void 0 || stopped || state.capping) return;
    clearCap();
    capTimer = setTimeout(onCap, Math.max(0, deadline + pausedMs - now()));
    capTimer.unref?.();
  };
  const sync = (step) => {
    if (stopped) return;
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
  return {
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
    observe(msg) {
      const step = mcpjamBackgroundDrainReducer(state, msg);
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
        } else if (msg.subtype === "task_updated" && state.backgroundIds.has(taskId)) {
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
      const step = mcpjamBackgroundDrainReducer(state, { type: "mcpjam-answer", at: now() });
      if (step.keepReading && !drainNoticeSent && !stopped) {
        drainNoticeSent = true;
        notice("draining");
      }
      sync(step);
      return step;
    },
    async isBackgroundAgentRequest(agentID) {
      if (typeof agentID !== "string" || agentID.length === 0) return false;
      const deadline = now() + MCPJAM_DRAIN_CLASSIFY_WAIT_MS;
      while (!state.backgroundIds.has(agentID) && !state.foregroundAgentIds.has(agentID) && now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (state.backgroundIds.has(agentID)) return true;
      if (state.foregroundAgentIds.has(agentID)) return false;
      return state.pending.size > 0;
    },
    deniedBackgroundApproval(toolName) {
      if (!stopped) notice("denied a background agent's approval request for " + toolName);
    },
    approvalStarted() {
      if (approvals++ === 0) {
        pausedSince = now();
        clearCap();
      }
    },
    approvalEnded() {
      if (approvals === 0) return;
      if (--approvals === 0) {
        if (pausedSince !== void 0 && state.drainStartedAt !== void 0) {
          pausedMs += Math.max(0, now() - Math.max(pausedSince, state.drainStartedAt));
        }
        pausedSince = void 0;
        armCap();
      }
    },
    stop,
    clear
  };
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
  // A Stop during the drain ends it at once: open blocks and the step close,
  // the CLI is aborted and the bridge still emits its normal `finish`. Before
  // the drain, Stop keeps the bridge's graceful interrupt.
  [
    `  const onHostAbort = () => {
    if (gracefulAbort) {`,
    `  const onHostAbort = () => {
    if (mcpjamDrainController?.draining) {
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
  // The controller (timers, notices, approvals). `q` is read lazily.
  [
    `  const skillsOption = toClaudeSkillsOption(start.skills);`,
    `  const mcpjamDrainController = mcpjamCreateBackgroundDrainController({
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
  // Approvals: deny a background agent's; a main-thread one pauses the cap.
  [
    `  const questionPreToolUseHook = createQuestionPreToolUseHook({`,
    `  const mcpjamCanUseTool = permissionOptions.canUseTool;
  const mcpjamPermissionMode = start.permissionMode ?? "allow-all";
  permissionOptions.canUseTool = async (toolName, toolInput, options) => {
    const needsApproval = !toolName.startsWith("mcp__harness-tools__") && (inactiveNativeTools.includes(toolName) || nativeToolRequiresApproval({
      nativeName: toolName,
      permissionMode: mcpjamPermissionMode
    }));
    if (!needsApproval) return mcpjamCanUseTool(toolName, toolInput, options);
    if (await mcpjamDrainController.isBackgroundAgentRequest(options?.agentID)) {
      mcpjamDrainController.deniedBackgroundApproval(toolName);
      return {
        behavior: "deny",
        message: MCPJAM_BACKGROUND_APPROVAL_DENIAL,
        ...typeof options?.toolUseID === "string" ? { toolUseID: options.toolUseID } : {}
      };
    }
    mcpjamDrainController.approvalStarted();
    try {
      return await mcpjamCanUseTool(toolName, toolInput, options);
    } finally {
      mcpjamDrainController.approvalEnded();
    }
  };
  const questionPreToolUseHook = createQuestionPreToolUseHook({`,
  ],
  // After the first successful answer, a terminal error is a notice plus a
  // normal finish: the answer the user already has stays theirs.
  [
    `    if (!normalized || emittedTerminalError || emittedTerminalFinish) return;
    streamEventState.observedTerminalError = normalized;`,
    `    if (!normalized || emittedTerminalError || emittedTerminalFinish) return;
    if (mcpjamDrainState.succeeded) {
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
      if (mcpjamDrainStep.ignoreResult) continue;
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
      if (state.mcpjamDrain?.backgroundIds.has(msg.task_id)) return;
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
