/**
 * Turning a PR into a reachable MCP server, inside a disposable E2B sandbox.
 *
 * The security shape of this module is the whole point, so it is stated up
 * front. Everything it runs is UNTRUSTED code from a pull request:
 *
 *   - the sandbox holds ZERO credentials. The clone is anonymous (public repo,
 *     no token), and nothing about MCPJam's own environment is passed in;
 *   - it runs a DEDICATED minimal template (`GITHUB_CHECKS_E2B_TEMPLATE_ID`:
 *     node + git, nothing else), never the shared computer template;
 *   - outbound network is DISABLED after the build and BEFORE the PR's server
 *     starts. The build needs egress (`npm ci`); the server does not, and the
 *     server is the part that runs for twenty minutes while an eval suite pokes
 *     at it. If the lockdown fails we treat it as `infra_error` and never start
 *     the server — an open-egress box running PR code is not an acceptable
 *     degraded mode;
 *   - inbound eval traffic still arrives through `getHost(port)`, which is why
 *     the box is created with `allowPublicTraffic: true`. That is a one-way
 *     door: we can reach in, the box cannot reach out.
 *
 * Failure attribution matters as much as failure detection. A build that exits
 * non-zero is the PR's problem (`build_failed`); a server that never answers
 * `initialize` is the PR's problem (`server_unhealthy`); E2B being unavailable
 * is OUR problem (`infra_error`). `CheckStepError` carries that verdict so the
 * worker never has to guess from an error message.
 */

import { Sandbox } from "e2b";
import { logger } from "../../utils/logger.js";
import type { CheckRecipe } from "./recipes.js";

/** Outcomes this module can produce. A subset of the worker's full taxonomy. */
export type CheckStepOutcome =
  | "build_failed"
  | "server_unhealthy"
  | "infra_error";

/**
 * A step failure that already knows how the PR's check should conclude.
 * `detailsMarkdown` is clamped, fenced, review-safe output (never raw).
 */
export class CheckStepError extends Error {
  constructor(
    readonly outcome: CheckStepOutcome,
    message: string,
    readonly detailsMarkdown?: string
  ) {
    super(message);
    this.name = "CheckStepError";
  }
}

/**
 * Structural view of the sandbox this module needs. Narrow on purpose: the unit
 * tests drive the whole build/start/health sequence through a fake, and a fake
 * of four methods stays honest where a fake of the entire E2B surface would not.
 */
export interface CheckSandbox {
  readonly sandboxId: string;
  getHost(port: number): string;
  commands: {
    run(
      command: string,
      opts?: {
        cwd?: string;
        timeoutMs?: number;
        background?: boolean;
        envs?: Record<string, string>;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      }
    ): Promise<unknown>;
  };
  updateNetwork(network: {
    allowInternetAccess?: boolean;
    denyOut?: string[];
  }): Promise<void>;
  kill(): Promise<void>;
}

/**
 * Worst case for one check: provision ~2m + clone/build ~10m + health ~2m +
 * eval ~20m + overhead. 45 minutes with `onTimeout: "kill"` is the orphan
 * backstop — if this process dies, E2B reaps the box on its own.
 */
export const CHECK_SANDBOX_TIMEOUT_MS = 45 * 60_000;
/** Build is a foreground command; E2B's own default (~60s) is far too short. */
export const BUILD_TIMEOUT_MS = 10 * 60_000;
export const CLONE_TIMEOUT_MS = 5 * 60_000;
export const HEALTH_TIMEOUT_MS = 2 * 60_000;
export const HEALTH_INTERVAL_MS = 2_000;
/**
 * Per-attempt cap on the health probe, clamped to the remaining deadline. A
 * healthy server answers `initialize` in milliseconds, so 10s is generous; the
 * point is that an unresponsive one cannot outlive the overall window.
 */
export const PROBE_ATTEMPT_TIMEOUT_MS = 10_000;
/**
 * Cap on how much of a probe response we read before deciding, in BYTES off the
 * wire — the unit the budget is actually spent in, so multi-byte output cannot
 * buy more of it than ASCII does. The answer we are looking for is the first
 * frame; anything past this is a server streaming at us, not a handshake.
 */
export const PROBE_MAX_RESPONSE_BYTES = 64 * 1024;
/** Where the PR is checked out inside the box. */
export const CHECKOUT_DIR = "/home/user/repo";

/** Cap on clamped untrusted output, in characters. */
export const OUTPUT_CLAMP_CHARS = 4_000;

/** How much of the started server's log we keep, for a health failure. */
const STDERR_TAIL_CHARS = 8_000;

/** Where the PR's server writes stdout+stderr, inside the box. */
const SERVER_LOG_PATH = "/tmp/mcp-server.log";
/** Cap on that file. A watchdog truncates it; see `startCommandScript`. */
const SERVER_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** How often the watchdog checks the log's size. */
const SERVER_LOG_CHECK_SECONDS = 30;

/**
 * The protocol version we offer in the health probe. Deliberately a plain
 * constant rather than the connect-form list: this probe only has to prove a
 * server is up and speaking MCP, and a server that negotiates down still
 * answers.
 */
const HEALTH_PROBE_PROTOCOL_VERSION = "2025-06-18";

/** The version the modern-era probe self-describes with. */
const MODERN_PROBE_PROTOCOL_VERSION = "2026-07-28";

/** The ids the probes send, and therefore the ids a real answer must carry. */
const LEGACY_PROBE_REQUEST_ID = 1;
const MODERN_PROBE_REQUEST_ID = 2;

/** Who the probe says it is, in both eras. */
const PROBE_CLIENT_INFO = {
  name: "mcpjam-github-checks-probe",
  version: "1.0.0",
} as const;

/**
 * Versions the probe will accept back from the PR's server.
 *
 * Hand-listed rather than imported: `check:mcp-v1-runtime-imports` forbids
 * reaching into the upstream v1 protocol SDK from inspector server code, and
 * `MCP_PROTOCOL_VERSIONS` in our own SDK is the narrower set a connection can be
 * PINNED to — it omits the legacy wire versions the client still accepts.
 *
 * The list must stay at least as permissive as the real client. A version this
 * probe rejects but the client would have accepted turns a working PR server
 * into a false `server_unhealthy`, which is worse than the neutral it replaces.
 * So: upstream's supported list, plus the newest revision our SDK knows.
 */
const HEALTH_PROBE_ACCEPTED_VERSIONS: ReadonlySet<string> = new Set([
  "2024-10-07",
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

/**
 * The subset of the above the MODERN negotiation arm can speak.
 *
 * A `server/discover` result is only evidence of a usable server if the versions
 * it offers overlap THIS set. A discover answer naming nothing but legacy
 * revisions asserts nothing about the modern arm — the client would fall back to
 * `initialize` for such a server, and whether that fallback works is exactly what
 * the legacy probe is for. Accepting it here would let a half-broken endpoint
 * (answers discover, cannot actually serve a modern session) read as healthy off
 * the arm that never proved it.
 */
const MODERN_PROBE_ACCEPTED_VERSIONS: ReadonlySet<string> = new Set([
  MODERN_PROBE_PROTOCOL_VERSION,
]);

/**
 * Make untrusted PR output safe to put in a GitHub check body.
 *
 * Mirrors the backend's `clampCheckOutput` (the two repos share no code). Three
 * things: drop control characters, keep only the tail and say so, and fence with
 * a backtick run longer than any inside the text — a build log containing ```
 * must not be able to break out of the block and inject markdown into our
 * message.
 */
export function clampOutput(text: string | null | undefined): string {
  if (typeof text !== "string" || text.trim().length === 0) return "";

  // CR is itself a control char, so normalize line endings first.
  const normalized = stripControlCharacters(
    text.replace(/\r\n?/g, "\n")
  ).trimEnd();
  if (normalized.length === 0) return "";

  const truncated = normalized.length > OUTPUT_CLAMP_CHARS;
  const body = truncated
    ? normalized.slice(normalized.length - OUTPUT_CLAMP_CHARS)
    : normalized;

  const longestBacktickRun = Math.max(
    0,
    ...Array.from(body.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));

  return [
    truncated ? `_Showing the last ${OUTPUT_CLAMP_CHARS} characters._` : "",
    `${fence}text`,
    body,
    fence,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function stripControlCharacters(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) {
      out += char;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f))
      continue;
    out += char;
  }
  return out;
}

export function isGithubChecksSandboxConfigured(): boolean {
  return Boolean(
    process.env.E2B_API_KEY?.trim() &&
      process.env.GITHUB_CHECKS_E2B_TEMPLATE_ID?.trim()
  );
}

/**
 * Create the box.
 *
 * The dedicated template is REQUIRED, with no fallback to the computer
 * template: that image carries a browser, a desktop, and the tooling a
 * Project Computer needs, none of which a PR's build should have access to.
 * A missing template id is a deployment error, not something to paper over.
 *
 * `provisionEvalSandbox` (the eval-run path) cannot be reused here: it resolves
 * its image from a run's frozen snapshot, and the run does not exist until the
 * server this box builds is reachable — chicken and egg.
 */
export async function provisionCheckSandbox(args: {
  triggerId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<CheckSandbox> {
  const apiKey = process.env.E2B_API_KEY?.trim();
  const templateId = process.env.GITHUB_CHECKS_E2B_TEMPLATE_ID?.trim();
  if (!apiKey || !templateId) {
    throw new CheckStepError(
      "infra_error",
      "github-checks sandbox requires E2B_API_KEY and GITHUB_CHECKS_E2B_TEMPLATE_ID"
    );
  }

  try {
    const sandbox = await Sandbox.create(templateId, {
      apiKey,
      timeoutMs: CHECK_SANDBOX_TIMEOUT_MS,
      // If this process dies mid-check, E2B kills the box rather than paying to
      // keep a snapshot of someone's PR build around.
      lifecycle: { onTimeout: "kill" },
      // Inbound only — the eval run reaches the server through `getHost`.
      // Egress is revoked separately, after the build.
      network: { allowPublicTraffic: true },
      metadata: {
        purpose: "github-checks",
        triggerId: args.triggerId,
        repoFullName: args.repoFullName,
        prNumber: String(args.prNumber),
      },
    });
    logger.info("[github-checks] sandbox provisioned", {
      sandboxId: sandbox.sandboxId,
      triggerId: args.triggerId,
    });
    return sandbox as unknown as CheckSandbox;
  } catch (error) {
    throw new CheckStepError(
      "infra_error",
      `sandbox provision failed: ${errorMessage(error)}`
    );
  }
}

type RunResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Foreground command, normalized. E2B throws on a non-zero exit; every caller
 * here wants the exit code and the streams, so translate the throw back into a
 * result and let the caller decide what a failure MEANS.
 */
async function runForeground(
  sandbox: CheckSandbox,
  command: string,
  opts: {
    cwd?: string;
    timeoutMs: number;
    /**
     * Whose fault it is when the command hits ITS OWN deadline. A build that
     * hangs is the PR's (`build_failed`) — E2B reports that as a timeout with no
     * exit code, which would otherwise land in the transport branch below and
     * conclude `neutral`, letting a hanging build dodge a red check.
     *
     * Two conditions, and both must hold: the clock we set is genuinely spent,
     * AND the error does not identify itself as a transport failure.
     *
     * Neither alone is enough, in opposite directions. The error's NAME cannot
     * decide it, because E2B raises `TimeoutError` for `Code.Unavailable` and
     * `Code.Canceled` too — an E2B outage during `npm ci` would become the PR's
     * broken build. Elapsed time cannot decide it alone either, because an
     * outage that happens to surface after the deadline would be attributed the
     * same way. So the clock opens the door and E2B's own description of the
     * failure can still close it, which biases every uncertain case toward
     * `infra_error` (neutral) rather than a red X on a good PR.
     */
    timeoutOutcome: CheckStepOutcome;
  }
): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    const result = (await sandbox.commands.run(command, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    })) as Partial<RunResult> | undefined;
    return {
      exitCode: result?.exitCode ?? 0,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
    };
  } catch (error) {
    const exit = error as Partial<RunResult> & { exitCode?: number };
    if (typeof exit?.exitCode === "number") {
      return {
        exitCode: exit.exitCode,
        stdout: exit.stdout ?? "",
        stderr: exit.stderr ?? "",
      };
    }
    if (
      Date.now() - startedAt >= opts.timeoutMs &&
      !looksLikeSandboxTransportFailure(error)
    ) {
      throw new CheckStepError(
        opts.timeoutOutcome,
        `command exceeded its ${Math.round(opts.timeoutMs / 1000)}s deadline`,
        clampOutput(`${exit.stdout ?? ""}\n${exit.stderr ?? ""}`) || undefined
      );
    }
    // Not a command failure — the sandbox itself is unreachable.
    throw new CheckStepError(
      "infra_error",
      `sandbox command failed: ${errorMessage(error)}`
    );
  }
}

/**
 * Does the error say the SANDBOX failed, rather than the command overrunning?
 *
 * E2B funnels three distinct RPC conditions into one `TimeoutError`, and only
 * `DeadlineExceeded` is the command's own deadline. The other two describe
 * themselves unmistakably — the sandbox being unavailable, or the per-request
 * timeout — and those are ours, not the PR's.
 */
function looksLikeSandboxTransportFailure(error: unknown): boolean {
  return /requestTimeoutMs|sandbox timeout|handshake|unavailable|canceled|cancelled/i.test(
    errorMessage(error)
  );
}

/**
 * Clone the PR head, anonymously.
 *
 * `refs/pull/<n>/head` rather than the branch name: the branch may have been
 * renamed or deleted since the webhook fired, and the PR ref is stable. The
 * detached checkout is then ASSERTED to be exactly `headSha`. That assert is
 * load-bearing — a force-push between the webhook and the clone would otherwise
 * have us build a different tree and report the verdict against the sha in the
 * check, i.e. quietly lie about what was tested.
 *
 * No credentials: the repo is public, so the clone is anonymous. This is what
 * lets the box hold nothing worth stealing.
 */
export async function cloneAndCheckout(
  sandbox: CheckSandbox,
  args: { repoFullName: string; prNumber: number; headSha: string }
): Promise<void> {
  const cloneUrl = `https://github.com/${args.repoFullName}.git`;
  const script = [
    `set -e`,
    `rm -rf ${CHECKOUT_DIR}`,
    // Shallow, but deep enough that a PR ref's own history resolves.
    `git clone --depth 50 ${shellQuote(cloneUrl)} ${CHECKOUT_DIR}`,
    `cd ${CHECKOUT_DIR}`,
    `git fetch --depth 50 origin ${shellQuote(`pull/${args.prNumber}/head`)}`,
    `git checkout --detach ${shellQuote(args.headSha)}`,
  ].join(" && ");

  const result = await runForeground(
    sandbox,
    `bash -lc ${shellQuote(script)}`,
    {
      timeoutMs: CLONE_TIMEOUT_MS,
      // A public repo we were just told about should clone promptly; a stall is
      // ours or GitHub's, matching how a non-zero clone exit is attributed.
      timeoutOutcome: "infra_error",
    }
  );
  if (result.exitCode !== 0) {
    // A public repo we were just told about should always clone. If it doesn't,
    // that is our problem (or GitHub's), not the PR author's.
    throw new CheckStepError(
      "infra_error",
      `clone/checkout failed (exit ${result.exitCode})`,
      clampOutput(`${result.stdout}\n${result.stderr}`)
    );
  }

  const head = await runForeground(
    sandbox,
    `git -C ${CHECKOUT_DIR} rev-parse HEAD`,
    {
      timeoutMs: 60_000,
      // `rev-parse` on a fresh clone is instant; a stall is the sandbox, not the PR.
      timeoutOutcome: "infra_error",
    }
  );
  const checkedOut = head.stdout.trim();
  if (checkedOut !== args.headSha) {
    throw new CheckStepError(
      "infra_error",
      `checkout drifted: expected ${args.headSha}, got ${
        checkedOut || "nothing"
      }`
    );
  }
}

/**
 * Revoke outbound network.
 *
 * Called between the build and the start, and its ordering is a security
 * property, not an optimization: `npm ci` needs the registry, the PR's server
 * does not, and the server is the long-lived process an attacker would use. A
 * failure here is `infra_error` and ABORTS — the caller must never fall back to
 * starting the server with egress still open.
 */
export async function lockDownEgress(sandbox: CheckSandbox): Promise<void> {
  try {
    // Equivalent to `denyOut: ['0.0.0.0/0']`; inbound (`allowPublicTraffic`) is
    // untouched, so the eval run can still reach the server.
    await sandbox.updateNetwork({ allowInternetAccess: false });
    logger.info("[github-checks] egress locked down", {
      sandboxId: sandbox.sandboxId,
    });
  } catch (error) {
    throw new CheckStepError(
      "infra_error",
      `failed to disable sandbox egress before starting PR code: ${errorMessage(
        error
      )}`
    );
  }
}

export type StartedServer = {
  /** Public https URL of the MCP endpoint, via the sandbox host bridge. */
  url: string;
  /** Bounded tail of the server's own log, for a health failure message. */
  readStderrTail: () => Promise<string>;
};

/**
 * Build, lock down egress, start, and wait for the server to speak MCP.
 *
 * The step ORDER is the contract this function exists to guarantee, so it is
 * one function rather than three the caller sequences:
 *
 *   1. build (egress available)
 *   2. lock down egress            ← must land before any PR process is long-lived
 *   3. start the server
 *   4. poll `initialize` until it answers
 */
export async function buildAndStart(
  sandbox: CheckSandbox,
  recipe: CheckRecipe,
  options?: {
    fetchImpl?: typeof fetch;
    buildTimeoutMs?: number;
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
  }
): Promise<StartedServer> {
  const build = await runForeground(
    sandbox,
    `bash -lc ${shellQuote(recipe.build)}`,
    {
      cwd: CHECKOUT_DIR,
      timeoutMs: options?.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      timeoutOutcome: "build_failed",
    }
  );
  if (build.exitCode !== 0) {
    // The PR's own build broke. This is a check FAILURE, attributed to the PR —
    // not an infrastructure error, and not something to retry.
    throw new CheckStepError(
      "build_failed",
      `build command exited ${build.exitCode}`,
      clampOutput(`${build.stdout}\n${build.stderr}`)
    );
  }

  await lockDownEgress(sandbox);

  try {
    // Output goes to a FILE IN THE BOX, not to a stream callback. E2B's
    // `CommandHandle` appends every chunk it receives to an internal string —
    // it does that whether or not `onStderr` is supplied, and it starts doing it
    // the moment the handle is constructed. A PR server that logs continuously
    // for the twenty minutes an eval takes would therefore grow THIS process's
    // heap without limit, which no client-side ring buffer can prevent. Nothing
    // is streamed now; the tail is fetched, bounded, only if we need it.
    await sandbox.commands.run(
      `bash -lc ${shellQuote(startCommandScript(recipe.start))}`,
      {
        cwd: CHECKOUT_DIR,
        background: true,
        // REQUIRED. `timeoutMs` defaults to 60 SECONDS and applies to background
        // commands too, so without this the PR's server dies about a minute
        // after it starts, in the middle of a suite that legitimately runs for
        // twenty. The box's own TTL is the real bound, so use it. (Not `0`: E2B
        // forwards the value to connect-rpc, which treats <= 0 as an
        // already-expired deadline and would abort the spawn instantly.)
        timeoutMs: CHECK_SANDBOX_TIMEOUT_MS,
      }
    );
  } catch (error) {
    throw new CheckStepError(
      "infra_error",
      `failed to spawn the start command: ${errorMessage(error)}`
    );
  }

  const readServerLogTail = () => readLogTail(sandbox);
  const url = `https://${sandbox.getHost(recipe.port)}${recipe.mcpPath}`;
  const healthy = await waitForMcpInitialize(url, {
    timeoutMs: options?.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
    intervalMs: options?.healthIntervalMs ?? HEALTH_INTERVAL_MS,
    fetchImpl: options?.fetchImpl,
  });
  if (!healthy) {
    throw new CheckStepError(
      "server_unhealthy",
      `server never completed MCP initialize on port ${recipe.port}${recipe.mcpPath}`,
      clampOutput(await readServerLogTail())
    );
  }

  return { url, readStderrTail: readServerLogTail };
}

/**
 * The PR's start command, wrapped so its output is bounded on BOTH sides.
 *
 * Redirecting to a file keeps untrusted output out of this process's heap (see
 * the spawn site), but a file alone is just the same denial-of-service moved to
 * the sandbox's disk: a server that logs continuously fills it, and `ENOSPC` can
 * take down the very server we are evaluating — turning a chatty PR into a
 * failing one. So a watchdog truncates the log whenever it grows past the cap.
 *
 * Details that matter:
 *   - APPEND (`>>`), not truncate (`>`). With `>` the writer keeps its offset
 *     across a truncation, leaving a sparse hole whose tail reads as NUL padding;
 *     `O_APPEND` restarts cleanly at zero and keeps `tail -c` meaningful.
 *   - `exec` for the server, so it replaces the shell and kill/signal semantics
 *     stay those of the process itself.
 *   - the watchdog is a child of that shell and needs no cleanup: it dies with
 *     the sandbox, and if it dies early the only consequence is an unbounded log.
 */
function startCommandScript(startCommand: string): string {
  return [
    `: > ${SERVER_LOG_PATH}`,
    `( while :; do sleep ${SERVER_LOG_CHECK_SECONDS};` +
      ` if [ "$(wc -c < ${SERVER_LOG_PATH} 2>/dev/null || echo 0)" -gt ${SERVER_LOG_MAX_BYTES} ];` +
      ` then : > ${SERVER_LOG_PATH}; fi; done ) &`,
    `exec ${startCommand} >> ${SERVER_LOG_PATH} 2>&1`,
  ].join("\n");
}

/**
 * Fetch a bounded tail of the PR server's log, from inside the box.
 *
 * `tail -c` does the truncation in the sandbox, so untrusted output is bounded
 * BEFORE it crosses into this process. Best effort by design: this only ever
 * runs to enrich a failure message, and failing to read a log must not change
 * the verdict.
 */
async function readLogTail(sandbox: CheckSandbox): Promise<string> {
  try {
    const result = (await sandbox.commands.run(
      `bash -lc ${shellQuote(
        `tail -c ${STDERR_TAIL_CHARS} ${SERVER_LOG_PATH} 2>/dev/null || true`
      )}`,
      { timeoutMs: 30_000 }
    )) as { stdout?: string } | undefined;
    return result?.stdout ?? "";
  } catch {
    return "";
  }
}

/**
 * Poll the server until it answers a real MCP request.
 *
 * A TCP connect or an HTTP 200 on `/` would be a weaker signal: a framework
 * often serves before its MCP transport is mounted, and the eval run's very
 * first act is a real request. Probing with the real thing means "healthy" means
 * the same thing here and there.
 *
 * BOTH eras are probed, alternating one per attempt: the legacy `initialize`
 * handshake and the modern `server/discover`. The eval run connects with
 * automatic era negotiation, so a modern-only endpoint (the official handler with
 * `legacy: "reject"`, say) is one it can drive perfectly well — probing legacy
 * alone would call that server `server_unhealthy` and put a red X on a good PR.
 * Either answer proves the same thing this probe is asking.
 *
 * Accepts a JSON body or an SSE frame for either — streamable-HTTP servers
 * legally answer with either.
 */
export async function waitForMcpInitialize(
  url: string,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? HEALTH_INTERVAL_MS;
  const doFetch = options?.fetchImpl ?? fetch;
  const now = options?.now ?? (() => Date.now());
  const pause = options?.sleep ?? ((ms: number) => sleep(ms));

  const deadline = now() + timeoutMs;
  // Legacy first: nearly every server speaks it, so the common case answers on
  // the very first attempt. A modern-only endpoint answers on the second.
  const eras = [legacyInitializeProbe(), modernDiscoverProbe()];

  let attempts = 0;
  while (now() <= deadline) {
    attempts += 1;
    // Bound EACH attempt, not just the loop. A PR's server that accepts the
    // socket and then never answers — or answers with an endless stream — would
    // otherwise park this await indefinitely: the deadline is only consulted
    // between attempts, so an unbounded request means the check occupies the
    // worker's single in-flight slot until the 45-minute sandbox TTU instead of
    // concluding `server_unhealthy` in two minutes. Untrusted code is exactly
    // the code that does this.
    const attemptBudgetMs = Math.max(
      1,
      Math.min(PROBE_ATTEMPT_TIMEOUT_MS, deadline - now())
    );
    // One era per attempt, ALTERNATING — not both inside one attempt. A server
    // that accepts a POST and then holds the response open answers the first
    // era's request by never finishing it, so that era would eat the whole
    // budget every time and the other would never get a turn: a legacy-only
    // server would read as `server_unhealthy` because its probe never ran. Over
    // a two-minute window each era still gets tens of attempts.
    const era = eras[(attempts - 1) % eras.length];
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), attemptBudgetMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: era.headers,
        body: era.body,
        // The same signal covers the body read below: aborting it errors the
        // response stream, so a server that sends headers and then stalls is
        // bounded too.
        signal: abort.signal,
      });
      if (
        response.ok &&
        (await probeResponseIsHealthy(response, era.accepts))
      ) {
        return true;
      }
    } catch {
      // Connection refused, DNS not ready, this era rejected outright, or our
      // own abort — all "not healthy yet, try the other era next poll".
    } finally {
      clearTimeout(abortTimer);
      // Tear the requests down unconditionally. A streamable-HTTP server holds
      // the response stream open after answering, and we have our answer.
      abort.abort();
    }
    if (now() + intervalMs > deadline) break;
    await pause(intervalMs);
  }
  logger.warn("[github-checks] server never answered an MCP request", {
    url,
    attempts,
  });
  return false;
}

/** One era's probe: what to send, and what counts as an answer. */
interface EraProbe {
  headers: Record<string, string>;
  body: string;
  accepts: (parsed: unknown) => boolean;
}

/**
 * The legacy (2025-era) handshake: `initialize`, negotiated in the body.
 */
function legacyInitializeProbe(): EraProbe {
  return {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: LEGACY_PROBE_REQUEST_ID,
      method: "initialize",
      params: {
        protocolVersion: HEALTH_PROBE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: PROBE_CLIENT_INFO,
      },
    }),
    accepts: isUsableInitializeResponse,
  };
}

/**
 * The modern (2026-07-28) era has no handshake: every request self-describes
 * through a `_meta` envelope, and `server/discover` is its one universally
 * available request — the same liveness probe the manager itself uses.
 */
function modernDiscoverProbe(): EraProbe {
  return {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_PROBE_PROTOCOL_VERSION,
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: MODERN_PROBE_REQUEST_ID,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion":
            MODERN_PROBE_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": PROBE_CLIENT_INFO,
        },
      },
    }),
    accepts: isUsableDiscoverResponse,
  };
}

/**
 * Decide from the probe response WITHOUT waiting for the body to end.
 *
 * `response.text()` cannot be used here. A streamable-HTTP MCP server answers
 * `initialize` on an SSE stream and then KEEPS THAT STREAM OPEN — that is the
 * whole point of the transport. `text()` only resolves when the body ends, so it
 * would never resolve against a healthy server: every attempt would hit its
 * abort timer and the check would report `server_unhealthy` for a server that
 * answered correctly in milliseconds. (The fixture happens to close after each
 * response, which is exactly why this could pass its tests and still fail on a
 * real server.)
 *
 * So read incrementally and return the moment the accumulated text carries an
 * initialize result, then cancel the stream. `PROBE_MAX_RESPONSE_BYTES` bounds
 * a server that streams unrelated output at us forever.
 */
async function probeResponseIsHealthy(
  response: Response,
  accepts: (parsed: unknown) => boolean
): Promise<boolean> {
  // Same gate the eval run's transport applies: a streamable-HTTP response must
  // be `application/json` or `text/event-stream`, or the transport throws
  // `Unexpected content type` before it ever looks at the body. Accepting a
  // well-formed result served as `text/plain` would call that server healthy and
  // then hand its failure to us as neutral `infra_error`, when it is the PR's.
  const mode = transportPayloadMode(response);
  if (mode === null) return false;

  const body = (response as { body?: unknown }).body as
    | ReadableStream<Uint8Array>
    | null
    | undefined;
  if (!body || typeof body.getReader !== "function") {
    // No streaming body available (a buffered runtime, or a test stub): the
    // payload is already in hand, so reading it cannot block — and nothing more
    // is coming, so an unterminated last event is all we will ever get.
    return carriesAcceptedAnswer(await response.text(), accepts, true, mode);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // Spent in bytes, tracked separately from `text.length`. Decoded length is in
  // UTF-16 units, so budgeting by it would let non-ASCII output read more of the
  // wire than the cap allows — the slice below is in bytes either way.
  let remainingBytes = PROBE_MAX_RESPONSE_BYTES;
  try {
    while (remainingBytes > 0) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        // Decode only what fits. Decoding the whole chunk and checking after the
        // fact would let one large write blow straight past the cap. A sequence
        // cut in half here is held by the decoder (`stream: true`) and completed
        // by the next chunk, or dropped if the budget runs out first.
        const consumed = Math.min(value.byteLength, remainingBytes);
        remainingBytes -= consumed;
        text += decoder.decode(value.subarray(0, consumed), { stream: true });
        // Checked per chunk: a frame can arrive split, and a partial JSON just
        // fails to parse and waits for the rest. Mid-stream, so an event whose
        // terminating blank line has not arrived yet is held, not parsed.
        if (carriesAcceptedAnswer(text, accepts, false, mode)) return true;
      }
      if (done) {
        text += decoder.decode();
        return carriesAcceptedAnswer(text, accepts, true, mode);
      }
    }
    // Out of byte budget. Nothing further will be read, so this is the last look:
    // parse whatever the truncated tail holds rather than discarding it.
    return carriesAcceptedAnswer(text, accepts, true, mode);
  } finally {
    // We are done with this response either way — a healthy server is still
    // holding the stream open, so drop it rather than leaking the socket.
    void reader.cancel().catch(() => {});
  }
}

/**
 * How the streamable-HTTP transport would read this response's body, or `null`
 * if it would refuse to read it at all.
 *
 * The transport does not sniff the body: it switches on the declared media type,
 * handing `text/event-stream` to its EventSource parser and `application/json`
 * to `response.json()`. So the header decides which framing is in force, and the
 * OTHER framing is not a fallback — an SSE-framed body under `application/json`
 * makes `response.json()` throw, and a bare JSON body under `text/event-stream`
 * yields no events at all, leaving the client's `initialize` unanswered until it
 * times out. Either way that server is unusable, and accepting it here would
 * turn the PR's fault into our neutral `infra_error`.
 *
 * Compared on the essence only — parameters (`; charset=utf-8`) are legal and
 * the transport ignores them too. A missing header is a rejection: the transport
 * has nothing to match and fails the same way.
 */
function transportPayloadMode(response: Response): "json" | "sse" | null {
  const header = response.headers?.get?.("content-type");
  if (typeof header !== "string") return null;
  const essence = header.split(";", 1)[0].trim().toLowerCase();
  if (essence === "application/json") return "json";
  if (essence === "text/event-stream") return "sse";
  return null;
}

/**
 * Whether the text read so far carries an answer this era accepts. An error
 * response is still a live MCP server, but not a usable one — the eval run's own
 * connection would fail the same way, so treat it as not-yet-healthy and keep
 * polling until the deadline.
 */
function carriesAcceptedAnswer(
  text: string,
  accepts: (parsed: unknown) => boolean,
  streamEnded: boolean,
  mode: "json" | "sse"
): boolean {
  for (const payload of candidatePayloads(text, streamEnded, mode)) {
    try {
      if (accepts(JSON.parse(payload))) return true;
    } catch {
      // Not JSON (a proxy's HTML error page, a partial frame) — keep looking.
    }
  }
  return false;
}

/**
 * The candidate JSON payloads in the body, framed the way its declared media
 * type says to frame them.
 */
function candidatePayloads(
  text: string,
  streamEnded: boolean,
  mode: "json" | "sse"
): string[] {
  return mode === "sse"
    ? ssePayloads(text, streamEnded)
    : jsonPayloads(text, streamEnded);
}

/**
 * The one candidate payload in an `application/json` body: the whole body.
 *
 * Withheld until the body is complete, because `response.json()` is what the
 * transport calls and that needs the whole thing. Deciding early would also let
 * a server whose body is one valid JSON document followed by more content (a
 * second document, trailing junk) be accepted at the instant the first document
 * lands — and `response.json()` rejects exactly that, so the client would fail
 * where the probe passed.
 */
function jsonPayloads(text: string, streamEnded: boolean): string[] {
  if (!streamEnded) return [];
  const document = text.trim();
  return document ? [document] : [];
}

/**
 * The candidate JSON payloads in a `text/event-stream` body: the data of each
 * complete event.
 *
 * A payload comes only from a line that STARTS with `data:` — a body under this
 * media type that carries no such line carries no events, and the transport's
 * EventSource parser would surface nothing to the client no matter how valid the
 * JSON in it looks. (Which is also why "data:" appearing INSIDE a JSON string —
 * a serverInfo name, an instructions blob, a tool description — is not a frame.)
 *
 * Within one event, consecutive `data:` fields are JOINED with newlines, per SSE
 * semantics. A server that spreads one JSON-RPC message across several fields is
 * legal, and parsing each line on its own made every fragment fail to parse.
 *
 * `streamEnded` says whether more bytes can still arrive. While the stream is
 * live, an event whose terminating blank line has not been seen yet is INCOMPLETE
 * and is withheld: a multi-field event read at a chunk boundary would otherwise be
 * handed to `JSON.parse` a field short. That mostly just fails to parse, but a
 * server whose first field happens to be a complete JSON object followed by more
 * fields would be accepted off a truncated read. The unfinished event stays in
 * `text`, so the next chunk simply re-parses it whole. Once the stream is over
 * (or we stop reading), the tail is all there is, so parse it.
 */
function ssePayloads(text: string, streamEnded: boolean): string[] {
  const payloads: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      payloads.push(current.join("\n"));
      current = [];
    }
  };

  // LF, CRLF and bare CR are all legal SSE line separators, and a leading BOM is
  // stripped before parsing — that is what the transport's EventSource parser
  // does, so a server it can drive must not be turned away here. Splitting on LF
  // alone left a CR-separated frame unrecognised and the probe timed out.
  const segments = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  // The final segment is whatever follows the last separator, so mid-stream it is
  // a PARTIAL line, not a line. Treating it as one is subtly wrong in both
  // directions: a half-written `data:` field would be parsed a character short,
  // and — the case that actually bites — the empty tail left by a trailing
  // separator would read as the event's blank-line terminator, flushing an event
  // the server has not finished. A real terminator shows up as an empty segment
  // with another segment after it. (A CRLF split across chunk boundaries is safe
  // because the whole accumulated text is re-split on every read, never appended
  // to a previous parse.)
  const lineCount = streamEnded ? segments.length : segments.length - 1;
  for (let index = 0; index < lineCount; index += 1) {
    const line = segments[index];
    if (line.startsWith("data:")) {
      current.push(line.slice("data:".length).trim());
      continue;
    }
    // A blank line ends the event. Any other field (`event:`, `id:`, a comment)
    // carries no data but does not split it either.
    if (line === "") flush();
  }
  if (streamEnded) flush();
  return payloads.filter((payload) => payload.length > 0);
}

/**
 * Whether one parsed payload is an `initialize` answer the eval run's client
 * would accept.
 *
 * Every condition here is one the real client checks a moment later. Accepting
 * something looser buys nothing: the client rejects it, that rejection escapes
 * the eval path, and the worker reports neutral `infra_error` — so a broken PR
 * server dodges the `server_unhealthy` it earned and the failure lands on us
 * instead of on the PR. So mirror the client:
 *
 *   - the JSON-RPC envelope (`jsonrpc: "2.0"`, and the id we actually sent, so a
 *     stray notification or an answer to someone else's request is not ours);
 *   - a `result`, not an `error`;
 *   - `protocolVersion` the client can speak;
 *   - `capabilities` and `serverInfo`, both required by `InitializeResultSchema`.
 */
function isUsableInitializeResponse(parsed: unknown): boolean {
  const result = jsonRpcResultFor(parsed, LEGACY_PROBE_REQUEST_ID);
  if (!result) return false;
  const initialize = result as {
    protocolVersion?: unknown;
    capabilities?: unknown;
    serverInfo?: unknown;
  };
  if (
    typeof initialize.protocolVersion !== "string" ||
    !HEALTH_PROBE_ACCEPTED_VERSIONS.has(initialize.protocolVersion)
  ) {
    return false;
  }
  if (!isUsableCapabilities(initialize.capabilities)) return false;
  return isServerIdentity(initialize.serverInfo);
}

/**
 * The capability fields the client's schema gives a shape to. Every one it types
 * is an object, so `tools: true` is a schema violation the client will reject.
 *
 * Deliberately a closed list rather than "every value must be an object": the
 * client's capabilities schema passes unknown keys through untouched, so a server
 * advertising some extension as a bare string is still one the eval run can
 * drive. Rejecting it here would be stricter than the client — a false
 * `server_unhealthy` on a working PR, which is the failure this whole predicate
 * exists to avoid.
 */
const TYPED_CAPABILITY_FIELDS = [
  "tools",
  "prompts",
  "resources",
  "logging",
  "completions",
  "experimental",
] as const;

function isUsableCapabilities(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const capabilities = value as Record<string, unknown>;
  return TYPED_CAPABILITY_FIELDS.every(
    (field) =>
      capabilities[field] === undefined || isPlainObject(capabilities[field])
  );
}

/**
 * Whether one parsed payload is a `server/discover` answer the eval run's client
 * would accept. The modern era's equivalent of the checks above:
 *
 *   - the envelope and our id;
 *   - `supportedVersions`, a non-empty list of strings, with at least one the
 *     MODERN arm can actually speak — an endpoint offering nothing in common is
 *     no more usable than a legacy server naming an unsupported version, and one
 *     offering only legacy revisions is a question for the legacy probe;
 *   - `capabilities`, an object whose typed fields are objects.
 *
 * Server identity lives in `_meta` here and is a SHOULD, not a member of the
 * result, so its absence is not a defect and is not required.
 */
function isUsableDiscoverResponse(parsed: unknown): boolean {
  const result = jsonRpcResultFor(parsed, MODERN_PROBE_REQUEST_ID);
  if (!result) return false;
  const discover = result as {
    supportedVersions?: unknown;
    capabilities?: unknown;
  };
  if (!Array.isArray(discover.supportedVersions)) return false;
  const offered = discover.supportedVersions.filter(
    (version): version is string => typeof version === "string"
  );
  if (offered.length !== discover.supportedVersions.length) return false;
  if (!offered.some((version) => MODERN_PROBE_ACCEPTED_VERSIONS.has(version))) {
    return false;
  }
  return isUsableCapabilities(discover.capabilities);
}

/**
 * The `result` of a JSON-RPC response to OUR request, or null. Rejects an error
 * response, a notification, and an answer bearing someone else's id.
 */
function jsonRpcResultFor(parsed: unknown, expectedId: number): object | null {
  if (!isPlainObject(parsed)) return null;
  const message = parsed as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
  };
  if (message.jsonrpc !== "2.0") return null;
  if (message.id !== expectedId) return null;
  return isPlainObject(message.result) ? (message.result as object) : null;
}

/** An object, and not an array — `typeof [] === "object"` alone is too loose. */
function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ name, version }`, both strings — what the client's schema requires. */
function isServerIdentity(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const identity = value as { name?: unknown; version?: unknown };
  return (
    typeof identity.name === "string" && typeof identity.version === "string"
  );
}

/** Best-effort teardown. E2B's TTL + `onTimeout: "kill"` is the real backstop. */
export async function killCheckSandbox(
  sandbox: CheckSandbox | null
): Promise<void> {
  if (!sandbox) return;
  try {
    await sandbox.kill();
  } catch (error) {
    logger.warn("[github-checks] sandbox kill failed (E2B TTL will reap it)", {
      sandboxId: sandbox.sandboxId,
      error: errorMessage(error),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Single-quote for `bash -lc`, so a repo name or sha can never inject. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error);
}
