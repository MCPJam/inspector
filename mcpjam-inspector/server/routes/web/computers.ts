/**
 * Project Computers — web routes for the data-plane split.
 *
 *   GET  /config  (open)    Which data plane serves this inspector: itself
 *                           (`localConfigured`, it holds the vendor key +
 *                           secrets) or a deployed one (`remoteDataPlaneUrl`,
 *                           the NON-secret COMPUTERS_REMOTE_DATA_PLANE_URL).
 *                           The client uses this to aim the terminal
 *                           WebSocket and to render an honest empty state
 *                           when neither is available. No secrets here — a
 *                           boolean and a public URL.
 *
 *   POST /exec    (bearer)  Run one command on the CALLER'S computer. This is
 *                           what a credential-less local inspector forwards
 *                           its `bash` tool calls to (remote-data-plane.ts).
 *                           Authorization is the user's bearer end to end:
 *                           it's forwarded to Convex `/computers/reserve`,
 *                           which only ever resolves the (project, user)
 *                           computer of the bearer's owner — the shared
 *                           secret stays on this server. Returns the bash
 *                           tool's result shape; soft failures are
 *                           `{ error }` with HTTP 200 so the delegating
 *                           tool can relay them conversationally.
 *                           This route never delegates further — an
 *                           unconfigured server reports `{ error }`, so a
 *                           misconfigured remote URL can't forward in a loop.
 */
import { Hono } from "hono";
import { z } from "zod";
import { executionScopeSchema } from "../../utils/execution-scope.js";
import { isComputersDataPlaneConfigured } from "../../utils/computers/control-plane-client.js";
import { getComputersRemoteDataPlaneUrl } from "../../utils/computers/remote-data-plane.js";
import {
  MAX_COMMAND_TIMEOUT_S,
  e2bRunner,
  runComputerCommand,
  type BashRunner,
} from "../../utils/computers/run-command.js";
import { handleRoute, parseWithSchema, readJsonBody } from "./auth.js";
import { assertBearerToken } from "./errors.js";

const execSchema = z.object({
  projectId: z.string().min(1),
  // Phase 3: a delegating server forwards the opaque execution scope so this
  // data plane's reserve re-resolves live access. Shape-validated only; the
  // backend authorizes it. Absent ⇒ legacy projectId reserve.
  executionScope: executionScopeSchema.optional(),
  command: z.string().min(1).max(10_000),
  /** Idempotency key for the durable command log (the tool call id). */
  commandId: z.string().min(1).max(200),
  workdir: z.string().min(1).max(1_000).optional(),
  timeoutSeconds: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_S).optional(),
});

export function createComputersRoutes(runner: BashRunner = e2bRunner): Hono {
  const computers = new Hono();

  computers.get("/config", (c) =>
    c.json({
      localConfigured: isComputersDataPlaneConfigured(),
      remoteDataPlaneUrl: getComputersRemoteDataPlaneUrl(),
    })
  );

  computers.post("/exec", async (c) =>
    handleRoute(c, async () => {
      const bearerToken = assertBearerToken(c);
      const body = parseWithSchema(execSchema, await readJsonBody(c));
      return runComputerCommand(
        {
          authHeader: `Bearer ${bearerToken}`,
          projectId: body.projectId,
          ...(body.executionScope
            ? { executionScope: body.executionScope }
            : {}),
          command: body.command,
          commandId: body.commandId,
          source: "chat",
          ...(body.workdir ? { workdir: body.workdir } : {}),
          ...(body.timeoutSeconds !== undefined
            ? { timeoutSeconds: body.timeoutSeconds }
            : {}),
          signal: c.req.raw.signal,
        },
        runner
      );
    })
  );

  return computers;
}

export default createComputersRoutes();
