import { namesTasksExtension } from "./metadata.js";
import { TASKS_READINESS_CATALOG } from "../conformance-catalog.js";

import { MCP_TASKS_EXTENSION_ID } from "../mcp-client-manager/tasks-dispatch.js";

import {
  isRecord,
  errorMessage,
  passed,
  failed,
  notApplicable,
  couldNotRun,
} from "./metadata.js";
import { captureTaskRequestHeaders } from "./shapes.js";
import {
  INVALID_PARAMS,
  UndeclaredProbe,
  describeUndeclaredProbe,
} from "./evidence.js";
import type { TaskCheckContext } from "./check-context.js";
export async function runMutationChecks(context: TaskCheckContext) {
  const {
    operations,
    wire,
    createdTaskId,
    noTask,
    selected,
    checks,
    manager,
    serverId,
    received,
    sent,
    readiness,
  } = context;
  if (selected.has("tasks-invalid-task-id-rejected")) {
    const stepStartedAt = Date.now();
    if (wire !== "extension") {
      checks.push(
        notApplicable(
          "tasks-invalid-task-id-rejected",
          "check applies to the extension wire only"
        )
      );
    } else {
      // The mutating calls only feed advice, so a run that left that
      // advice out must not send them.
      const pickedAdvice = operations.config.readinessIds;
      const probe = await operations.probeUnknownTaskId(
        manager,
        serverId,
        !pickedAdvice ||
          pickedAdvice.includes("tasks-readiness-unknown-task-id-mutations")
      );
      // tasks.md:795 — `-32602` is a MUST for `tasks/get` and only a
      // SHOULD for the two mutating methods, so the same wrong answer
      // is a failure on one and advice on the others.
      const wrongAnswers = probe.mutations
        .filter(
          (entry) =>
            entry.outcome !== "local-failure" && entry.code !== INVALID_PARAMS
        )
        .map(
          (entry) =>
            `${entry.method} answered with ${
              entry.outcome === "answered"
                ? "a normal result"
                : String(entry.code)
            }`
        );
      if (wrongAnswers.length > 0) {
        readiness.push({
          id: "tasks-readiness-unknown-task-id-mutations",
          checkId: "tasks-invalid-task-id-rejected",
          title:
            TASKS_READINESS_CATALOG["tasks-readiness-unknown-task-id-mutations"]
              .title,
          severity: "warning",
          specStrength: "SHOULD",
          message: `An unknown task id should be rejected with -32602 (Invalid params): ${wrongAnswers.join("; ")}.`,
          details: { probedTaskId: probe.taskId, wrongAnswers },
          informational: true,
        });
      }
      const detail = { probedTaskId: probe.taskId, ...probe.detail };
      checks.push(
        probe.get.outcome === "local-failure"
          ? couldNotRun(
              "tasks-invalid-task-id-rejected",
              `tasks/get for an unknown task id produced no JSON-RPC response (${
                probe.get.message ?? "no message"
              }), so the rejection requirement was not put to the server`,
              detail
            )
          : probe.get.code === INVALID_PARAMS
            ? passed(
                "tasks-invalid-task-id-rejected",
                Date.now() - stepStartedAt,
                detail
              )
            : failed(
                "tasks-invalid-task-id-rejected",
                Date.now() - stepStartedAt,
                probe.get.outcome === "answered"
                  ? `tasks/get for the unknown task id ${JSON.stringify(
                      probe.taskId
                    )} was answered instead of rejected; the extension requires -32602 (Invalid params)`
                  : `tasks/get for an unknown task id was rejected with ${probe.get.code} rather than -32602 (Invalid params)`,
                detail
              )
      );
    }
  }

  if (selected.has("tasks-mcp-name-routing")) {
    const stepStartedAt = Date.now();
    const isHttp = "url" in operations.config.serverConfig;
    if (!isHttp) {
      checks.push(
        notApplicable(
          "tasks-mcp-name-routing",
          "Mcp-Name routing applies to HTTP transports only"
        )
      );
    } else if (wire !== "extension") {
      checks.push(
        notApplicable(
          "tasks-mcp-name-routing",
          "Mcp-Name task routing applies to the extension wire only"
        )
      );
    } else if (!createdTaskId) {
      checks.push(noTask("tasks-mcp-name-routing"));
    } else {
      // The requirement is about the OUTBOUND request, so the header
      // is captured off the fetch seam rather than inferred from a
      // successful read (a server that ignores the header would make a
      // read-only assertion pass vacuously).
      const observed = await captureTaskRequestHeaders(() =>
        manager.getTaskExt(serverId, createdTaskId)
      );
      const mcpName = observed.headers?.["mcp-name"];
      const mcpMethod = observed.headers?.["mcp-method"];
      checks.push(
        observed.error !== undefined
          ? failed(
              "tasks-mcp-name-routing",
              Date.now() - stepStartedAt,
              `tasks/get routed with Mcp-Name was rejected: ${errorMessage(
                observed.error
              )}`,
              { taskId: createdTaskId, mcpName, mcpMethod },
              observed.error
            )
          : mcpName === createdTaskId
            ? passed("tasks-mcp-name-routing", Date.now() - stepStartedAt, {
                taskId: createdTaskId,
                mcpName,
                mcpMethod,
              })
            : failed(
                "tasks-mcp-name-routing",
                Date.now() - stepStartedAt,
                observed.headers === undefined
                  ? "the routed poll succeeded but no HTTP request carrying Mcp-Name was observed, so the required routing header could not be verified"
                  : `tasks/get was routed with Mcp-Name ${JSON.stringify(
                      mcpName
                    )}; the extension requires the task id`,
                { taskId: createdTaskId, mcpName, mcpMethod }
              )
      );
    }
  }

  // These requests may mutate a task on a non-conforming server. The planner
  // gives them a dedicated subject, shared only by the two rejection checks.
  let undeclaredProbes: UndeclaredProbe[] | undefined;
  const needsUndeclaredProbes =
    selected.has("tasks-undeclared-capability-rejected") ||
    selected.has("tasks-undeclared-capability-names-requirements");
  if (needsUndeclaredProbes && wire === "extension" && createdTaskId) {
    undeclaredProbes = await operations.probeUndeclaredTaskMethods(
      manager,
      serverId,
      createdTaskId,
      sent
    );
  }

  if (selected.has("tasks-undeclared-capability-rejected")) {
    const stepStartedAt = Date.now();
    if (wire !== "extension") {
      checks.push(
        notApplicable(
          "tasks-undeclared-capability-rejected",
          "check applies to the extension wire only"
        )
      );
    } else if (!createdTaskId) {
      checks.push(noTask("tasks-undeclared-capability-rejected"));
    } else {
      const probes = undeclaredProbes;
      if (probes === undefined) {
        checks.push(
          couldNotRun(
            "tasks-undeclared-capability-rejected",
            "the connection exposes no raw request seam, so an undeclared call could not be sent and the -32021 requirement was not tested"
          )
        );
      } else {
        // tasks.md:797-799 — the server MUST answer -32021 for a
        // non-declaring client on tasks/get, tasks/update,
        // tasks/cancel and on task notifications requested through
        // subscriptions/listen. This is UNCONDITIONAL; anything else
        // (an answer, or another error code) is a violation.
        const offenders = probes.filter(
          (probe) =>
            probe.outcome !== "rejected" && probe.outcome !== "unsupported"
        );
        const warnings = probes
          .filter((probe) => probe.outcome === "unsupported")
          .map(
            (probe) =>
              `${probe.method} is not implemented by this server (-32601), so its undeclared-request requirement was not probed`
          );
        checks.push(
          offenders.length === 0
            ? passed(
                "tasks-undeclared-capability-rejected",
                Date.now() - stepStartedAt,
                { taskId: createdTaskId, probes },
                warnings
              )
            : failed(
                "tasks-undeclared-capability-rejected",
                Date.now() - stepStartedAt,
                `${
                  offenders.length
                } undeclared request(s) were not rejected with -32021 (Missing Required Client Capability): ${offenders
                  .map(describeUndeclaredProbe)
                  .join("; ")}`,
                { taskId: createdTaskId, probes }
              )
        );
      }
    }
  }

  if (selected.has("tasks-undeclared-capability-names-requirements")) {
    const stepStartedAt = Date.now();
    if (wire !== "extension") {
      checks.push(
        notApplicable(
          "tasks-undeclared-capability-names-requirements",
          "check applies to the extension wire only"
        )
      );
    } else if (!createdTaskId) {
      // Distinct from the seam case below, and the distinction is the
      // whole product of a `could-not-run`: "no task existed to probe
      // with" and "the connection cannot send an undeclared request"
      // point the operator at different fixes.
      checks.push(noTask("tasks-undeclared-capability-names-requirements"));
    } else if (undeclaredProbes === undefined) {
      checks.push(
        couldNotRun(
          "tasks-undeclared-capability-names-requirements",
          "the connection exposes no raw request seam, so no undeclared request could be sent and no -32021 payload could be inspected"
        )
      );
    } else {
      const rejections = undeclaredProbes.filter(
        (probe) => probe.outcome === "rejected"
      );
      // The core schema types this member as `ClientCapabilities` and
      // marks it REQUIRED on the error, so anything that is not an
      // object — absent, null, an array, a string — violates it.
      const unnamed = rejections.filter(
        (probe) => !isRecord(probe.requiredCapabilities)
      );
      // The core spec: a `-32021` "whose `data.requiredCapabilities`
      // lists the missing capabilities" (basic/index.mdx, a MUST). The
      // missing capability here IS the tasks extension, so an object
      // that does not name it under `extensions` breaks that MUST too.
      const unspecific = rejections.filter(
        (probe) =>
          isRecord(probe.requiredCapabilities) &&
          !namesTasksExtension(probe.requiredCapabilities)
      );
      const unnamedMethods = unnamed.map((probe) => probe.method).join(", ");
      const unspecificMethods = unspecific
        .map((probe) => probe.method)
        .join(", ");
      const problems = [
        ...(unnamed.length > 0
          ? [
              `${unnamed.length} -32021 rejection(s) carried no error.data.requiredCapabilities OBJECT: ${unnamedMethods}. The core schema types it as ClientCapabilities and requires it; a client told it is missing a capability, but not which one, cannot act on the error`,
            ]
          : []),
        ...(unspecific.length > 0
          ? [
              `${unspecific.length} -32021 rejection(s) carry a requiredCapabilities object that does not name ${MCP_TASKS_EXTENSION_ID} under \`extensions\`: ${unspecificMethods}. The core spec requires it to list the missing capabilities, and the missing one is the tasks extension`,
            ]
          : []),
      ];
      checks.push(
        rejections.length === 0
          ? couldNotRun(
              "tasks-undeclared-capability-names-requirements",
              "no request was rejected with -32021, so no error payload named a required capability"
            )
          : problems.length === 0
            ? passed(
                "tasks-undeclared-capability-names-requirements",
                Date.now() - stepStartedAt,
                {
                  rejections: rejections.map((probe) => ({
                    method: probe.method,
                    requiredCapabilities: probe.requiredCapabilities,
                  })),
                }
              )
            : failed(
                "tasks-undeclared-capability-names-requirements",
                Date.now() - stepStartedAt,
                problems.join(" "),
                {
                  unnamed: unnamed.map((probe) => probe.method),
                  unspecific: unspecific.map((probe) => probe.method),
                }
              )
      );
    }
  }

  // ORDERING: cancellation MUTATES the task, so it runs AFTER the
  // undeclared probes, not before them. It used to sit above, and that
  // let a PENDING check move a SCORED one: a server is allowed to
  // forget a task once it is cancelled (`probeCancelAck` documents and
  // tolerates exactly that class), and the undeclared probes reuse the
  // same task id. Cancel first and those probes are answered `-32602`
  // "unknown task" instead of `-32021`, which
  // `tasks-undeclared-capability-rejected` — frozen into `mcp-tasks` —
  // scores as a wrong-code FAILURE. A conforming server would fail on
  // probe order alone.
  //
  // The reverse exposure is strictly smaller: a server that wrongly
  // ACCEPTS an undeclared mutation may leave the task altered before
  // this check reads it, but such a server is already failing the
  // scored check, and the check it degrades here is pending. Cancelling
  // a task that already reached a terminal status is a weaker probe
  // than cancelling one mid-flight, but the assertion holds either way:
  // the spec requires an EMPTY ack and explicitly allows the status to
  // stay non-`cancelled` afterwards.
  if (selected.has("tasks-cancel-ack-shape")) {
    const stepStartedAt = Date.now();
    if (wire !== "extension") {
      checks.push(
        notApplicable(
          "tasks-cancel-ack-shape",
          "check applies to the extension wire only"
        )
      );
    } else if (!createdTaskId) {
      checks.push(noTask("tasks-cancel-ack-shape"));
    } else {
      const cancel = await operations.probeCancelAck(
        manager,
        serverId,
        createdTaskId,
        received
      );
      checks.push(
        cancel.unavailable !== undefined
          ? couldNotRun("tasks-cancel-ack-shape", cancel.unavailable)
          : cancel.problems.length === 0
            ? passed(
                "tasks-cancel-ack-shape",
                Date.now() - stepStartedAt,
                cancel.detail,
                cancel.warnings
              )
            : failed(
                "tasks-cancel-ack-shape",
                Date.now() - stepStartedAt,
                `tasks/cancel was not acknowledged as the extension requires: ${cancel.problems.join(
                  "; "
                )}`,
                cancel.detail
              )
      );
    }
  }
}
