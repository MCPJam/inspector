import { namesTasksExtension, errorCode } from "./metadata.js";
import { isTasksToolCheck } from "./types.js";

import type { RpcLogEvent } from "../mcp-client-manager/index.js";

import { MCP_TASKS_EXTENSION_ID } from "../mcp-client-manager/tasks-dispatch.js";

import { withTasksClient } from "./client-lifecycle.js";
import {
  AUTHORIZATION_REQUIRED_MESSAGE,
  isAuthorizationRefusal,
} from "../conformance-authorization.js";
import {
  credentialsFromServerConfig,
  loginRequiredDetails,
} from "../conformance-login.js";
import { needsSetupDetails, noTaskCreatedCopy } from "../conformance-input.js";
import { badToolArgsMessage, checkToolArgs } from "../conformance-tool-args.js";

import {
  buildConformanceProfileStamp,
  conformanceProfile,
  partitionByProfile,
} from "../conformance-profile.js";
import {
  MCP_TASKS_CHECK_IDS,
  type MCPTasksCheckId,
  type MCPTasksCheckResult,
  type MCPTasksConformanceResult,
  type MCPTasksReadinessWarning,
  type MCPTasksUncheckedAdvice,
} from "./types.js";

import {
  isRecord,
  errorMessage,
  passed,
  failed,
  notApplicable,
  couldNotRun,
  summarizeChecks,
  buildSummary,
  decideOutcome,
  toolTaskSupport,
  resolveProbeTool,
  findDeclarationViolations,
} from "./metadata.js";
import { validateCreateTaskShape } from "./shapes.js";
import {
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY,
  RawTaskResponse,
  findRawTaskResponse,
  describeUndiscriminatedTask,
  InputRequiredLeg,
} from "./evidence.js";
import { TaskOperations } from "./task-operations.js";
import { runReadChecks } from "./read-checks.js";
import { runMutationChecks } from "./mutation-checks.js";
export class TaskGroupRunner extends TaskOperations {
  async run(): Promise<MCPTasksConformanceResult> {
    const startedAt = Date.now();
    const selected = new Set<MCPTasksCheckId>(
      this.config.checkIds ?? MCP_TASKS_CHECK_IDS
    );
    const checks: MCPTasksCheckResult[] = [];
    // The extension's SHOULDs, reported beside the verdict rather than as a
    // check's warnings.
    const readiness: MCPTasksReadinessWarning[] = [];
    const uncheckedAdvice: MCPTasksUncheckedAdvice[] = [];
    const sent: unknown[] = [];
    // The RAW inbound bytes. Every task check that has to judge the
    // discriminator reads this, because by the time a result reaches the
    // manager the decoder has already made up its mind — see
    // {@link findRawTaskResponse}. Captured once, used by both creation checks.
    const received: unknown[] = [];

    const captureRpc = (event: RpcLogEvent) => {
      if (event.direction === "send") sent.push(event.message);
      else received.push(event.message);
      this.config.serverConfig.rpcLogger?.(event);
    };

    // Hoisted above the `try` so the connection-failure path can stamp it too.
    // A report that omits its profile is unusable for the one thing the stamp
    // exists for: a reader comparing two runs must be able to tell whether they
    // asked the same questions, and "failed to connect" is still a run.
    const profile = conformanceProfile("mcp-tasks");

    try {
      return await withTasksClient(
        this.config.serverConfig,
        async (manager, serverId) => {
          this.config.signal?.throwIfAborted();
          const support = manager.getTasksSupport(serverId);
          const wire = support.wire;
          const protocolVersion =
            manager.getNegotiatedProtocolVersion(serverId);

          if (selected.has("tasks-wire-resolvable")) {
            const stepStartedAt = Date.now();
            // Listing the extension on 2025-11-25 is not judged: nothing
            // forbids it, and SEP-2663 only forbids USING it there.
            checks.push(
              protocolVersion
                ? passed("tasks-wire-resolvable", Date.now() - stepStartedAt, {
                    protocolVersion,
                    wire,
                    support,
                  })
                : failed(
                    "tasks-wire-resolvable",
                    Date.now() - stepStartedAt,
                    'server did not expose a negotiated protocol version; tasks dispatch fails closed to "none"'
                  )
            );
          }

          const needsTool = [...selected].some(isTasksToolCheck);
          const tools = needsTool
            ? ((await manager.listTools(serverId)).tools ?? [])
            : [];
          this.config.signal?.throwIfAborted();
          const taskCapableTools = tools.filter(
            (tool) => toolTaskSupport(tool) !== undefined
          );
          const probe = resolveProbeTool(wire, tools, this.config.toolName);
          const probeTool = probe.tool;
          /**
           * The check verdict for "there is no probe tool", per resolution. A
           * missing or unlisted tool is the caller's setup to fix, so it costs
           * no point either way.
           */
          const missingProbeTool = (id: MCPTasksCheckId) =>
            probe.blocking
              ? couldNotRun(
                  id,
                  probe.reason ?? "no probe tool resolved",
                  needsSetupDetails(
                    "tasksProbe",
                    this.config.toolName
                      ? `This server doesn't list the tool ${JSON.stringify(
                          this.config.toolName
                        )}, so there was no task to check. Select a listed tool in setup, then run again.`
                      : undefined
                  )
                )
              : notApplicable(id, probe.reason ?? "no probe tool resolved");
          /**
           * Arguments the picked tool's own schema rejects are the caller's
           * setup to fix, not a server fault. `undefined` when they fit, or
           * when we cannot tell, so the server-side verdict stands.
           */
          const argsVerdict = probeTool
            ? checkToolArgs(
                probeTool.inputSchema,
                this.config.toolArguments ?? {}
              )
            : undefined;
          const badArgs = (
            id: MCPTasksCheckId,
            message?: string
          ): MCPTasksCheckResult | undefined => {
            if (!probeTool || argsVerdict?.verdict !== "invalid")
              return undefined;
            const text =
              message ??
              badToolArgsMessage(probeTool.name, argsVerdict.message);
            return couldNotRun(id, text, {
              tool: probeTool.name,
              argsProblem: argsVerdict.message,
              ...needsSetupDetails("tasksProbe", text),
            });
          };

          let createdTaskId: string | undefined;
          let creationResult: unknown;
          /** The creation response as it arrived, before decoding. */
          let rawCreation: RawTaskResponse | undefined;

          const needsTask = [...selected].some(
            (id) =>
              isTasksToolCheck(id) && id !== "tasks-undeclared-creation-refused"
          );
          if (needsTask && wire !== "none" && probeTool) {
            const receivedBefore = received.length;
            try {
              creationResult =
                wire === "extension"
                  ? await manager.executeTool(
                      serverId,
                      probeTool.name,
                      this.config.toolArguments ?? {},
                      { allowTaskResult: true }
                    )
                  : await manager.executeTool(
                      serverId,
                      probeTool.name,
                      this.config.toolArguments ?? {},
                      undefined,
                      {}
                    );
              createdTaskId = this.extractTaskId(wire, creationResult);
            } catch (error) {
              creationResult = error;
            }
            // Read the wire regardless of how decoding went: an
            // undiscriminated task both LOOKS like a plain result and can make
            // result decoding fail, and neither may be scored as conformance.
            rawCreation = findRawTaskResponse(received.slice(receivedBefore));
          }

          this.config.signal?.throwIfAborted();
          if (selected.has("tasks-result-type-discipline")) {
            const stepStartedAt = Date.now();
            if (!probeTool) {
              checks.push(missingProbeTool("tasks-result-type-discipline"));
            } else if (
              wire === "extension" &&
              rawCreation &&
              !rawCreation.discriminated
            ) {
              // BEFORE the decoded-result branches, and deliberately so: this
              // is the one violation the decoded result cannot show, because
              // an undiscriminated task arrives as an ordinary result (or
              // fails decoding). Judged on the wire, it is unambiguous.
              checks.push(
                failed(
                  "tasks-result-type-discipline",
                  Date.now() - stepStartedAt,
                  describeUndiscriminatedTask(rawCreation),
                  {
                    tool: probeTool.name,
                    taskId: rawCreation.taskId,
                    resultType: rawCreation.resultType ?? null,
                  }
                )
              );
            } else if (creationResult instanceof Error) {
              checks.push(
                badArgs("tasks-result-type-discipline") ??
                  failed(
                    "tasks-result-type-discipline",
                    Date.now() - stepStartedAt,
                    `task-eligible tools/call failed: ${errorMessage(
                      creationResult
                    )}`,
                    { tool: probeTool.name },
                    creationResult
                  )
              );
            } else if (createdTaskId === undefined) {
              // Server-decided: declining to produce a task is conformant, as
              // long as what comes back is a normal tool result.
              //
              // This branch used to be a blind spot: a `CreateTaskResult` with
              // no `resultType` lands here too, since task detection is keyed
              // on `resultType === "task"` at the transport seam
              // (`rewriteTaskResultMessage`), so it arrives as an ordinary
              // result. It no longer reaches this branch — the raw-wire check
              // above judges the discriminator on the bytes, so "the server
              // declined a task" now means the wire carried no task at all.
              checks.push(
                isRecord(creationResult)
                  ? passed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      {
                        tool: probeTool.name,
                        outcome: "non-task result (server declined the task)",
                      }
                    )
                  : failed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      "tools/call returned neither a tool result object nor a task"
                    )
              );
            } else {
              const verdict =
                wire === "extension"
                  ? validateCreateTaskShape(creationResult)
                  : { violations: [], warnings: [] };
              checks.push(
                verdict.violations.length === 0
                  ? passed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      { tool: probeTool.name, taskId: createdTaskId },
                      verdict.warnings
                    )
                  : failed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      `${verdict.violations.length} task creation shape violation(s)`,
                      { violations: verdict.violations }
                    )
              );
            }
          }

          if (selected.has("tasks-undeclared-creation-refused")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-undeclared-creation-refused",
                  "check applies to the extension wire only"
                )
              );
            } else if (!probeTool) {
              checks.push(
                missingProbeTool("tasks-undeclared-creation-refused")
              );
            } else {
              // tasks.md:61 — a server MUST NOT return `CreateTaskResult` to a
              // client that did not include the extension capability ON THAT
              // REQUEST, regardless of prior declarations.
              const creation = await this.probeUndeclaredCreation(
                manager,
                serverId,
                probeTool.name,
                received
              );
              // A bad tool input must not be mistaken for a capability refusal.
              if (
                creation.outcome === "refused" &&
                creation.code !== MISSING_REQUIRED_CLIENT_CAPABILITY
              ) {
                try {
                  creationResult = await manager.executeTool(
                    serverId,
                    probeTool.name,
                    this.config.toolArguments ?? {},
                    { allowTaskResult: true }
                  );
                } catch (error) {
                  creationResult = error;
                }
              }
              const stepDurationMs = Date.now() - stepStartedAt;
              if (creation.outcome === "created") {
                checks.push(
                  failed(
                    "tasks-undeclared-creation-refused",
                    stepDurationMs,
                    `an undeclared tools/call returned a CreateTaskResult; a server must not create a task for a client that never declared the tasks capability (it must answer normally or reject with -32021)${
                      creation.discriminated
                        ? ""
                        : '. The payload also carries no resultType "task" discriminator, so it was only visible on the raw wire — a client cannot discriminate it and the task is unreachable (tasks.md:102)'
                    }`,
                    {
                      tool: probeTool.name,
                      taskId: creation.taskId,
                      discriminated: creation.discriminated,
                    }
                  )
                );
              } else if (creation.outcome === "errored") {
                // Not a pass: the probe never obtained a server response, so
                // tasks.md:61 was not exercised at all.
                checks.push(
                  failed(
                    "tasks-undeclared-creation-refused",
                    stepDurationMs,
                    `the undeclared tools/call produced no JSON-RPC response (${creation.message}), so the server was never tested; re-run against a reachable server`,
                    { tool: probeTool.name, outcome: creation.outcome }
                  )
                );
              } else if (
                creation.outcome === "refused" &&
                creation.code !== MISSING_REQUIRED_CLIENT_CAPABILITY &&
                creationResult instanceof Error &&
                errorCode(creationResult) === creation.code
              ) {
                // The DECLARED call failed with the same code, so the refusal
                // is about the tool name or arguments, not the missing
                // capability. Blaming -32021 here would point the developer
                // at a problem they do not have.
                checks.push(
                  badArgs(
                    "tasks-undeclared-creation-refused",
                    "Your tool failed even with tasks turned on, so there was nothing to check. Check the tool and args in setup."
                  ) ??
                    couldNotRun(
                      "tasks-undeclared-creation-refused",
                      `the tools/call fails with ${creation.code} even with the tasks extension declared, so the undeclared refusal cannot be tied to the missing capability; check --tool-name and --tool-args`,
                      {
                        tool: probeTool.name,
                        outcome: creation.outcome,
                        undeclaredCreationCode: creation.code,
                      }
                    )
                );
              } else if (
                creation.outcome === "refused" &&
                creation.code !== MISSING_REQUIRED_CLIENT_CAPABILITY
              ) {
                // tasks.md:63 — a server that cannot serve the request without
                // a `CreateTaskResult` "MUST return an error with the code
                // `-32021`". A refusal with any other code breaks that MUST.
                checks.push(
                  failed(
                    "tasks-undeclared-creation-refused",
                    stepDurationMs,
                    creation.code ===
                      OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY
                      ? "the undeclared tools/call was rejected with -32003, the code the tasks extension carried before it was corrected to -32021; a refusal must use -32021 (tasks.md:63)"
                      : `the undeclared tools/call was rejected with ${creation.code}; a refusal must use -32021 (Missing Required Client Capability) (tasks.md:63)`,
                    {
                      tool: probeTool.name,
                      outcome: creation.outcome,
                      undeclaredCreationCode: creation.code,
                    }
                  )
                );
              } else if (
                creation.outcome === "refused" &&
                !namesTasksExtension(creation.requiredCapabilities)
              ) {
                // tasks.md:63 — the `-32021` is returned "indicating the
                // required extension in the error response".
                checks.push(
                  failed(
                    "tasks-undeclared-creation-refused",
                    stepDurationMs,
                    `the undeclared tools/call was rejected with -32021, but its error.data.requiredCapabilities does not name ${MCP_TASKS_EXTENSION_ID} under \`extensions\`; the refusal must indicate the required extension (tasks.md:63)`,
                    {
                      tool: probeTool.name,
                      outcome: creation.outcome,
                      undeclaredCreationCode: creation.code,
                      requiredCapabilities: creation.requiredCapabilities,
                    }
                  )
                );
              } else {
                checks.push(
                  passed("tasks-undeclared-creation-refused", stepDurationMs, {
                    tool: probeTool.name,
                    outcome: creation.outcome,
                    ...(creation.outcome === "refused"
                      ? { undeclaredCreationCode: creation.code }
                      : {}),
                  })
                );
              }
            }
          }

          // FIRST poll stops at `input_required` as well as at a terminal
          // status: an input-gated task cannot advance without a client answer,
          // so continuing would only spend `pollTimeoutMs` to reach the state
          // already in hand. `pollToTerminal` requires the gate to be OBSERVED
          // as parked before it stops — see the note there on why one frame is
          // not enough.
          this.config.signal?.throwIfAborted();
          const needsPolling = [...selected].some((id) =>
            [
              "tasks-ttl-shape",
              "tasks-inline-result",
              "tasks-status-payload-shape",
              "tasks-ttl-integer-shape",
              "tasks-update-ack-shape",
            ].includes(id)
          );
          const polled =
            createdTaskId && needsPolling
              ? await this.pollToTerminal(
                  manager,
                  serverId,
                  wire,
                  createdTaskId,
                  {
                    stopOnInputRequired: true,
                  }
                )
              : {};

          // The isolated input-required update leg. Opt-in on
          // `inputResponses` for the same reason the protocol suite's fixtures
          // are: what a task asks for is server-defined, and inventing an
          // answer submits arbitrary content into somebody's workflow.
          const inputRequiredTask = polled.inputRequired
            ? polled.task
            : undefined;
          let inputLeg: InputRequiredLeg | undefined;
          if (
            selected.has("tasks-update-ack-shape") &&
            inputRequiredTask &&
            createdTaskId &&
            wire === "extension"
          ) {
            inputLeg = await this.runInputRequiredLeg(
              manager,
              serverId,
              createdTaskId,
              inputRequiredTask,
              received
            );
          }

          const finalTask = polled.task;
          // Distinguishes "there was never a task" from "polling the task
          // failed", so no dependent check skips under a message that hides a
          // broken read. Every branch here leaves the check UNEXERCISED, so the
          // verdict is `could-not-run` — except when no probe tool resolved at
          // all, where the resolution already decided whether that is a gap or
          // an inapplicability (no tasks wire).
          const noTask = (id: MCPTasksCheckId): MCPTasksCheckResult => {
            if (!probeTool) return missingProbeTool(id);
            // A thrown call is not "a normal result": say the call failed, so
            // the app's setup advice does not hide the real error.
            if (!createdTaskId && creationResult instanceof Error) {
              return (
                badArgs(id) ??
                couldNotRun(
                  id,
                  `calling ${JSON.stringify(
                    probeTool.name
                  )} failed, so there was no task to check: ${errorMessage(
                    creationResult
                  )}`
                )
              );
            }
            if (!createdTaskId) {
              // A tool error is not "no task": with arguments that fit, the
              // tool itself failed, which is the server's to answer for.
              if (isRecord(creationResult) && creationResult.isError === true) {
                return (
                  badArgs(id) ??
                  couldNotRun(
                    id,
                    `${JSON.stringify(
                      probeTool.name
                    )} returned a tool error instead of a task, so there was nothing to check`,
                    { tool: probeTool.name, toolError: true }
                  )
                );
              }
              // The server may decline to make a task; picking a tool that
              // makes one is the caller's setup, so this costs no point.
              return couldNotRun(
                id,
                `${JSON.stringify(
                  probeTool.name
                )} returned a normal result instead of a task, so there was nothing to check; pass --tool-name (SDK: toolName) with a tool that creates a task, or --tool-args (SDK: toolArguments) that make this one create a task`,
                {
                  tool: probeTool.name,
                  ...needsSetupDetails(
                    "tasksProbe",
                    noTaskCreatedCopy(probeTool.name)
                  ),
                }
              );
            }
            return couldNotRun(
              id,
              polled.error === undefined
                ? `task ${createdTaskId} was never readable within ${this.config.pollTimeoutMs}ms`
                : `polling task ${createdTaskId} failed: ${errorMessage(
                    polled.error
                  )}`
            );
          };

          const context = {
            operations: this,
            wire,
            finalTask,
            createdTaskId,
            noTask,
            selected,
            checks,
            manager,
            serverId,
            inputRequiredTask,
            inputLeg,
            received,
            sent,
            rawCreation,
            readiness,
            uncheckedAdvice,
          };
          this.config.signal?.throwIfAborted();
          await runReadChecks(context);
          this.config.signal?.throwIfAborted();
          await runMutationChecks(context);
          this.config.signal?.throwIfAborted();
          if (selected.has("tasks-declaration-hygiene")) {
            const stepStartedAt = Date.now();
            const violations = findDeclarationViolations(wire, sent);
            checks.push(
              violations.length === 0
                ? passed(
                    "tasks-declaration-hygiene",
                    Date.now() - stepStartedAt,
                    { inspectedRequests: sent.length, wire }
                  )
                : failed(
                    "tasks-declaration-hygiene",
                    Date.now() - stepStartedAt,
                    `${violations.length} declaration hygiene violation(s)`,
                    { violations }
                  )
            );
          }

          // Which of these the `mcp-tasks` profile scores. A check outside the
          // frozen manifest still ran and still shows its verdict in `checks`,
          // but it is excluded from the verdict and the score — a scenario
          // added this week must not retroactively fail a server that was green
          // last week. Same mechanism as the protocol suite, separate manifest.
          const { scored, pending } = partitionByProfile(checks, profile);
          // An empty SCORED set is not the same fact as an empty CHECK set.
          // `decideOutcome([])` says "no checks were selected", which is the
          // exact opposite of what happened when every selected check ran and
          // all of them are pending (`--check-id tasks-cancel-ack-shape`).
          // Same reasoning, and same shape, as the protocol runner.
          const verdict =
            scored.length === 0 && pending.length > 0
              ? {
                  outcome: "incomplete" as const,
                  incompleteReason: `all ${pending.length} selected check(s) ran but are unscored by profile ${profile.id}@${profile.version}, so this run establishes no conformance verdict`,
                }
              : decideOutcome(scored);
          // Advice the caller left out is not reported.
          const pickedAdvice = this.config.readinessIds;
          const pickedReadiness = readiness.filter(
            (warning) => !pickedAdvice || pickedAdvice.includes(warning.id)
          );
          const pickedUnchecked = uncheckedAdvice.filter(
            (entry) => !pickedAdvice || pickedAdvice.includes(entry.id)
          );

          for (const check of checks) {
            if (isTasksToolCheck(check.id))
              check.details = {
                ...check.details,
                ...(probeTool || this.config.toolName
                  ? { toolName: probeTool?.name ?? this.config.toolName }
                  : {}),
                ...(createdTaskId ? { taskId: createdTaskId } : {}),
              };
          }
          return {
            passed: verdict.outcome === "passed",
            outcome: verdict.outcome,
            ...(verdict.incompleteReason
              ? { incompleteReason: verdict.incompleteReason }
              : {}),
            target: this.config.target,
            checks,
            ...(pickedReadiness.length > 0
              ? { readiness: pickedReadiness }
              : {}),
            ...(pickedUnchecked.length > 0
              ? { uncheckedAdvice: pickedUnchecked }
              : {}),
            summary:
              pending.length > 0
                ? `${buildSummary(scored)}, ${pending.length} pending (unscored by profile ${profile.id}@${profile.version})`
                : buildSummary(scored),
            durationMs: Date.now() - startedAt,
            // The tally reports EVERYTHING that ran, pending included: a report
            // that hid them would misstate what the run did.
            categorySummary: summarizeChecks(checks),
            profile: buildConformanceProfileStamp({
              profile,
              checks,
              ...(protocolVersion ? { protocolVersion } : {}),
            }),
            discovery: {
              protocolVersion,
              wire,
              toolCount: tools.length,
              taskCapableToolCount: taskCapableTools.length,
              ...(probeTool ? { probedTool: probeTool.name } : {}),
              ...(createdTaskId ? { createdTaskId } : {}),
            },
          };
        },
        {
          serverId: "__tasks_conformance__",
          clientName: "mcpjam-sdk-tasks-conformance",
          timeout: this.config.timeout,
          rpcLogger: captureRpc,
          signal: this.config.signal,
          onRequest: this.requestHeaders.observe,
        }
      );
    } catch (error) {
      this.config.signal?.throwIfAborted();
      // Refused for credentials: nothing was reached, so every selected check
      // could not run — `incomplete`, not `failed`. Each one is reported, so
      // the run names what it was asked rather than one stand-in check.
      const results: MCPTasksCheckResult[] = isAuthorizationRefusal(error)
        ? [...selected].map((id) =>
            couldNotRun(
              id,
              AUTHORIZATION_REQUIRED_MESSAGE,
              loginRequiredDetails(
                error,
                credentialsFromServerConfig(this.config.serverConfig)
              )
            )
          )
        : [...selected].map((id) =>
            failed(
              id,
              Date.now() - startedAt,
              `Failed to connect to ${this.config.target}: ${errorMessage(error)}`,
              undefined,
              error
            )
          );
      for (const check of results) {
        if (isTasksToolCheck(check.id) && this.config.toolName)
          check.details = { ...check.details, toolName: this.config.toolName };
      }
      const verdict = decideOutcome(results);
      return {
        passed: verdict.outcome === "passed",
        outcome: verdict.outcome,
        ...(verdict.incompleteReason
          ? { incompleteReason: verdict.incompleteReason }
          : {}),
        target: this.config.target,
        checks: results,
        summary: buildSummary(results),
        durationMs: Date.now() - startedAt,
        categorySummary: summarizeChecks(results),
        profile: buildConformanceProfileStamp({ profile, checks: results }),
        discovery: {
          wire: "none",
          toolCount: 0,
          taskCapableToolCount: 0,
          ...(this.config.toolName ? { probedTool: this.config.toolName } : {}),
        },
      };
    }
  }
}
