/**
 * Project Computers — web routes for the data-plane split.
 *
 *   GET  /config  (open)    Which data plane serves this inspector: itself
 *                           (`localConfigured`, it holds the vendor key +
 *                           secrets) or a deployed one (`remoteDataPlaneUrl`,
 *                           the NON-secret COMPUTERS_REMOTE_DATA_PLANE_URL —
 *                           explicit, or auto-discovered via Convex; see
 *                           remote-data-plane.ts). Awaits any in-flight
 *                           discovery so the client's cached first answer is
 *                           never a false negative. The client uses this to
 *                           aim the terminal WebSocket and to render an
 *                           honest empty state when neither is available.
 *                           No secrets here — a boolean and a public URL.
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
import {
  HOSTED_MODE,
  LOCAL_BROWSER_ENABLED,
  LOCAL_HARNESS_ENABLED,
} from "../../config.js";
import { z } from "zod";
import { executionScopeSchema } from "../../utils/execution-scope.js";
import { resolveComputersLocalConfigured } from "../../utils/computers/runtime-config.js";
import { resolveComputersRemoteDataPlaneUrl } from "../../utils/computers/remote-data-plane.js";
import { isLocalComputerEngineAvailable } from "../../utils/computers/local-machine.js";
import { getLocalTerminalAvailability } from "../../utils/computers/local-pty.js";
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

  computers.get("/config", async (c) => {
    // Await any in-flight startup bootstrap/discovery — the client caches
    // this FIRST response for the whole SPA session, so it must never race
    // a still-resolving lookup into a false "unconfigured".
    const [localConfigured, remoteDataPlaneUrl] = await Promise.all([
      resolveComputersLocalConfigured(),
      resolveComputersRemoteDataPlaneUrl(),
    ]);
    const localEngine = isLocalComputerEngineAvailable();
    // Probed once per process (node-pty is an optional native dep — see
    // local-pty.ts). False here is a clean degrade: chat bash still works, the
    // client just renders the terminal-off state.
    const localTerminal = await getLocalTerminalAvailability();
    // The capability SPLIT is the point of this shape: `remoteDataPlaneUrl`
    // delegates only PERSONAL-computer exec/terminal, so a remote-only
    // inspector can drive a personal Computer yet cannot execute one
    // disposable-sandbox command. Cloud-only surfaces (swarms/evals/user
    // testing) preflight on `ephemeralCloudAvailable`; a single "cloud
    // available" bit would lie to exactly those surfaces.
    const personalCloudAvailable = localConfigured || remoteDataPlaneUrl !== null;
    return c.json({
      // Legacy pair, verbatim — older clients read only these.
      localConfigured,
      remoteDataPlaneUrl,
      engines: {
        local: {
          available: localEngine.available,
          terminalAvailable: localTerminal.available,
          // This endpoint is OPEN (no bearer), so only the tilde display
          // root ever leaves the server — never an absolute home path or OS
          // username. The client renders `${workspaceDisplayRoot}/<projectId>`;
          // the server independently validates and resolves the real path at
          // exec time.
          workspaceDisplayRoot: localEngine.available
            ? "~/.mcpjam/computer"
            : null,
          // Whether this server would let the agent drive a browser here. A
          // capability bit, deliberately NOT whether Chromium is downloaded —
          // that is machine state and lives behind the authenticated
          // `/api/mcp/computers/local-browser/status`, alongside the install
          // that acts on it.
          browserAvailable: LOCAL_BROWSER_ENABLED,
          ...(localEngine.available ? {} : { reason: localEngine.reason }),
        },
        cloud: { available: personalCloudAvailable },
      },
      capabilities: {
        personalCloudAvailable,
        ephemeralCloudAvailable: localConfigured,
      },
      // Harness EXECUTION targets, which are a different axis from the
      // computer engines above: an engine decides where a bash tool call runs,
      // a target decides where the whole vendor agent runs. Reported here so a
      // client can render the selector without a second round trip.
      //
      // This endpoint is OPEN (no bearer), so the answer is deliberately
      // coarse: whether the capability exists on this server at all, and
      // nothing about this machine. The runtime's digest, the machine id, the
      // key fingerprint and the workspace display root all live behind the
      // authenticated `/api/mcp/local-harness/availability`.
      harnessTargets: {
        localNative: {
          // The server-side capability only. A flag-gated client still hides
          // everything, and the authenticated route is what decides whether a
          // pack is installed and a turn can actually run.
          serverEnabled: LOCAL_HARNESS_ENABLED && !HOSTED_MODE,
        },
      },
      // Honest tri-state: `null` when NO engine can serve this inspector —
      // a "cloud" default with every availability flag false would tell the
      // client to prefer an engine that does not exist.
      defaultEngine: localEngine.available
        ? "local"
        : personalCloudAvailable
          ? "cloud"
          : null,
    });
  });

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
