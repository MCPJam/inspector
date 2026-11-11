import { TASKS_READINESS_CATALOG } from "../conformance-catalog.js";

import {
  isRecord,
  errorMessage,
  passed,
  failed,
  notApplicable,
  couldNotRun,
} from "./metadata.js";
import {
  validateTaskTtlShape,
  validateTaskStatusPayload,
  failedTaskLacksStatusMessage,
  validateTaskTtlIntegerShape,
} from "./shapes.js";
import {
  TERMINAL_STATUSES,
  findRawTaskStates,
  findRawCreationTask,
  isRawTaskShaped,
  sentRequestIds,
} from "./evidence.js";
import type { TaskCheckContext } from "./check-context.js";
import { needsSetupDetails } from "../conformance-input.js";

const TASK_ANSWERS_REJECTED_MESSAGE =
  "The server rejected your input answers, so there was nothing to check. Fix the answers in setup, then run again.";
export async function runReadChecks(context: TaskCheckContext) {
  const {
    operations,
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
  } = context;
  if (selected.has("tasks-ttl-shape")) {
    const stepStartedAt = Date.now();
    if (!finalTask) {
      checks.push(noTask("tasks-ttl-shape"));
    } else {
      const verdict = validateTaskTtlShape(wire, finalTask);
      checks.push(
        verdict.violations.length === 0
          ? passed(
              "tasks-ttl-shape",
              Date.now() - stepStartedAt,
              undefined,
              verdict.warnings
            )
          : failed(
              "tasks-ttl-shape",
              Date.now() - stepStartedAt,
              `${verdict.violations.length} TTL shape violation(s)`,
              { violations: verdict.violations }
            )
      );
    }
  }

  if (selected.has("tasks-inline-result")) {
    const stepStartedAt = Date.now();
    if (!finalTask || !createdTaskId) {
      checks.push(noTask("tasks-inline-result"));
    } else if (!TERMINAL_STATUSES.has(String(finalTask.status))) {
      checks.push(
        couldNotRun(
          "tasks-inline-result",
          `task did not reach a terminal status within ${
            operations.config.pollTimeoutMs
          }ms (last status: ${String(
            finalTask.status
          )}); raise --poll-timeout (SDK: pollTimeoutMs) or probe a shorter-lived task`
        )
      );
    } else if (wire === "extension") {
      const hasInline =
        finalTask.status !== "completed" || finalTask.result !== undefined;
      const failedCarriesError =
        finalTask.status !== "failed" || isRecord(finalTask.error);
      checks.push(
        hasInline && failedCarriesError
          ? passed("tasks-inline-result", Date.now() - stepStartedAt, {
              status: finalTask.status,
            })
          : failed(
              "tasks-inline-result",
              Date.now() - stepStartedAt,
              hasInline
                ? "a failed task must carry a JSON-RPC error object"
                : "a completed task must carry its result INLINE on tasks/get (the extension has no tasks/result)",
              { status: finalTask.status }
            )
      );
    } else {
      try {
        const result = await manager.getTaskResult(serverId, createdTaskId);
        checks.push(
          isRecord(result)
            ? passed("tasks-inline-result", Date.now() - stepStartedAt, {
                status: finalTask.status,
              })
            : failed(
                "tasks-inline-result",
                Date.now() - stepStartedAt,
                "legacy tasks/result must return the original request's result"
              )
        );
      } catch (error) {
        checks.push(
          failed(
            "tasks-inline-result",
            Date.now() - stepStartedAt,
            `legacy tasks/result failed: ${errorMessage(error)}`,
            undefined,
            error
          )
        );
      }
    }
  }

  // Grades only the acknowledgement: "On success, the server MUST
  // acknowledge the request with an empty result" and "MUST be set to
  // `complete` on UpdateTaskResult". What the task does afterwards is
  // not graded — it may go back to `working`, ask for more input, or
  // take longer than `pollTimeoutMs`, and the extension allows all three.
  if (selected.has("tasks-update-ack-shape")) {
    const stepStartedAt = Date.now();
    if (wire !== "extension") {
      checks.push(
        notApplicable(
          "tasks-update-ack-shape",
          "tasks/update is an extension-wire method"
        )
      );
    } else if (!createdTaskId) {
      // NO TASK is a gap, not an inapplicability: the obligation went
      // untested because the run could not provoke a task at all.
      // `noTask` already draws that distinction (and reports the
      // no-probe-tool case the way resolution decided).
      checks.push(noTask("tasks-update-ack-shape"));
    } else if (!inputRequiredTask) {
      // A task that completes without ever asking for anything is the
      // normal case, and there is genuinely no update to grade — so
      // this one IS an inapplicability.
      checks.push(
        notApplicable(
          "tasks-update-ack-shape",
          `task ${createdTaskId} never reported input_required, so there was no tasks/update to send`
        )
      );
    } else if (!inputLeg || inputLeg.outcome === "no-responses-configured") {
      // Answers are opt-in operator setup, not a server obligation, so
      // leaving them out costs the server nothing.
      checks.push(
        notApplicable(
          "tasks-update-ack-shape",
          `task requested input for ${JSON.stringify(
            inputLeg?.requested ?? []
          )} but no inputResponses were configured; supply inputResponses to exercise tasks/update`
        )
      );
    } else if (inputLeg.outcome === "update-rejected") {
      // The MUST is conditioned on success, and the answers are
      // operator-supplied, so a rejection leaves no acknowledgement to
      // grade rather than proving a defect.
      // Answers that cannot satisfy what the task asked for are the caller's
      // setup to fix; a rejection of answers that fit is the server's.
      checks.push(
        inputLeg.answersProblem
          ? couldNotRun(
              "tasks-update-ack-shape",
              TASK_ANSWERS_REJECTED_MESSAGE,
              {
                requested: inputLeg.requested,
                answered: inputLeg.answered,
                answersProblem: inputLeg.answersProblem,
                ...needsSetupDetails(
                  "tasksProbe",
                  TASK_ANSWERS_REJECTED_MESSAGE
                ),
              }
            )
          : couldNotRun(
              "tasks-update-ack-shape",
              `tasks/update was rejected (${inputLeg.code ?? "no code"}: ${
                inputLeg.message ?? "no message"
              }), so there was no acknowledgement to grade; check the configured inputResponses`,
              { requested: inputLeg.requested, answered: inputLeg.answered }
            )
      );
    } else {
      const violations = inputLeg.ackVerdict?.violations ?? [];
      const details = {
        requested: inputLeg.requested,
        answered: inputLeg.answered,
      };
      checks.push(
        violations.length === 0
          ? passed(
              "tasks-update-ack-shape",
              Date.now() - stepStartedAt,
              details,
              inputLeg.ackVerdict?.warnings ?? []
            )
          : failed(
              "tasks-update-ack-shape",
              Date.now() - stepStartedAt,
              `tasks/update was not acknowledged with an empty result: ${violations.join(
                "; "
              )}`,
              details
            )
      );
    }
  }

  if (selected.has("tasks-status-payload-shape")) {
    const stepStartedAt = Date.now();
    // The payload rules below are the EXTENSION's (`result` inline on
    // `completed`, `error` on `failed`, `inputRequests` on
    // `input_required`). The legacy 2025-11-25 wire delivers a
    // completed task's result through a separate `tasks/result` call,
    // so grading a legacy payload against them reports a violation the
    // server never committed. Every sibling check gates on this; this
    // one did not.
    //
    // RAW, not the decoded task: the SDK's own payload schema rejects a
    // `failed` task with no `error` before any check sees it, so
    // reading the decoded task would score a server green on exactly
    // the malformed states this check exists to catch.
    //
    // EVERY observed payload, not just the final one. A run that
    // answers an `input_required` gate sees several statuses, and
    // grading only the state the task ended in would let a malformed
    // `input_required` frame pass behind a well-formed `completed` one.
    const rawStates =
      createdTaskId && wire === "extension"
        ? findRawTaskStates(
            received,
            createdTaskId,
            sentRequestIds(sent, "tasks/get")
          )
        : [];
    if (wire !== "extension") {
      checks.push(
        notApplicable(
          "tasks-status-payload-shape",
          "check applies to the extension wire only"
        )
      );
    } else if (rawStates.length === 0) {
      checks.push(
        createdTaskId
          ? couldNotRun(
              "tasks-status-payload-shape",
              `no raw tasks/get payload for task ${createdTaskId} was observed, so no status payload could be inspected`
            )
          : noTask("tasks-status-payload-shape")
      );
    } else {
      // Deduped by status + text: a server re-sends the same snapshot on
      // every poll while a gate is open, and reporting one violation
      // per poll would bury the finding in repeats of itself.
      const violations = new Set<string>();
      const warnings = new Set<string>();
      for (const state of rawStates) {
        const verdict = validateTaskStatusPayload(state);
        for (const violation of verdict.violations) {
          violations.add(`${String(state.status)}: ${violation}`);
        }
        for (const warning of verdict.warnings) {
          warnings.add(`${String(state.status)}: ${warning}`);
        }
      }
      if (rawStates.some(failedTaskLacksStatusMessage)) {
        readiness.push({
          id: "tasks-readiness-failed-status-message",
          checkId: "tasks-status-payload-shape",
          title:
            TASKS_READINESS_CATALOG["tasks-readiness-failed-status-message"]
              .title,
          severity: "warning",
          specStrength: "SHOULD",
          message:
            "A failed task carries no `statusMessage`; the extension recommends one so a human can see why it failed.",
          informational: true,
        });
      } else if (!rawStates.some((state) => state.status === "failed")) {
        uncheckedAdvice.push({
          id: "tasks-readiness-failed-status-message",
          title:
            TASKS_READINESS_CATALOG["tasks-readiness-failed-status-message"]
              .title,
          reason:
            "Not checked: the task didn't fail, so there was no failure reason to look at.",
        });
      }
      const observedStatuses = [
        ...new Set(rawStates.map((state) => String(state.status))),
      ];
      const details = {
        observedStatuses,
        inspectedPayloads: rawStates.length,
      };
      checks.push(
        violations.size === 0
          ? passed(
              "tasks-status-payload-shape",
              Date.now() - stepStartedAt,
              details,
              warnings.size > 0 ? [...warnings] : undefined
            )
          : failed(
              "tasks-status-payload-shape",
              Date.now() - stepStartedAt,
              `task status payload is incomplete: ${[...violations].join(
                "; "
              )}`,
              details
            )
      );
    }
  }

  if (selected.has("tasks-ttl-integer-shape")) {
    const stepStartedAt = Date.now();
    let integerTaskId = createdTaskId;
    if (!integerTaskId && rawCreation) {
      // The client could not decode the creation as a task, but the raw
      // frame names one. Use it only when the frame is task-shaped, not
      // an ordinary tool result that carries a `taskId` field.
      const raw = findRawCreationTask(
        received,
        rawCreation.taskId,
        sentRequestIds(sent, "tools/call")
      );
      if (raw && isRawTaskShaped(raw)) {
        integerTaskId = rawCreation.taskId;
      }
    }
    if (wire !== "extension") {
      // "integer milliseconds" is the EXTENSION's `Task` interface
      // talking. The legacy wire's `ttl`/`pollInterval` carry no such
      // statement, so grading them here would fail a legacy server
      // against a requirement its revision never made.
      checks.push(
        notApplicable(
          "tasks-ttl-integer-shape",
          "the integer-milliseconds statement belongs to the tasks extension; the legacy wire states no such bound"
        )
      );
    } else if (!integerTaskId) {
      checks.push(noTask("tasks-ttl-integer-shape"));
    } else {
      // EVERY task payload the server sent, not just the last. The
      // creation result and each `tasks/get` answer are all a `Task`,
      // both values MAY change across polls (tasks.md:308, :340), so a
      // fractional value on any one of them breaks the schema even when
      // the final one is clean. Read raw, like the status-payload check,
      // so the decoder cannot hide a value — and so a bad creation
      // result is still judged when no `tasks/get` was ever answered,
      // or when the client could not decode the creation as a task at
      // all (the raw frame still names its `taskId`). The decoded final
      // task is the fallback when no raw frame was captured.
      const creationPayload = findRawCreationTask(
        received,
        integerTaskId,
        sentRequestIds(sent, "tools/call")
      );
      const rawStates = findRawTaskStates(
        received,
        integerTaskId,
        sentRequestIds(sent, "tasks/get")
      );
      const payloads: Array<{ source: string; task: unknown }> = [
        // Only a task-shaped creation is a `Task`; an ordinary tool
        // result may carry a `taskId` and other extra fields.
        ...(creationPayload && isRawTaskShaped(creationPayload)
          ? [{ source: "tools/call", task: creationPayload }]
          : []),
        ...rawStates.map((state) => ({
          source: `tasks/get ${String(state.status)}`,
          task: state,
        })),
      ];
      if (payloads.length === 0 && finalTask) {
        payloads.push({ source: "final task", task: finalTask });
      }
      if (payloads.length === 0) {
        checks.push(noTask("tasks-ttl-integer-shape"));
      } else {
        // Deduped: a server re-sends the same snapshot on every poll.
        const violations = new Set<string>();
        const warnings = new Set<string>();
        for (const { source, task } of payloads) {
          const verdict = validateTaskTtlIntegerShape(wire, task);
          for (const violation of verdict.violations) {
            violations.add(`${source}: ${violation}`);
          }
          for (const warning of verdict.warnings) {
            warnings.add(`${source}: ${warning}`);
          }
        }
        const details = { inspectedPayloads: payloads.length };
        checks.push(
          violations.size === 0
            ? passed(
                "tasks-ttl-integer-shape",
                Date.now() - stepStartedAt,
                details,
                warnings.size > 0 ? [...warnings] : undefined
              )
            : failed(
                "tasks-ttl-integer-shape",
                Date.now() - stepStartedAt,
                `task TTL/poll interval are not integer milliseconds: ${[
                  ...violations,
                ].join("; ")}`,
                details
              )
        );
      }
    }
  }
}
