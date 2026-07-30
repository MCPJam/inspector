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
 * Cap on how much of a probe response we read before deciding. The answer we are
 * looking for is the first frame; anything past this is a server streaming at us,
 * not a handshake.
 */
export const PROBE_MAX_RESPONSE_CHARS = 64 * 1024;
/** Where the PR is checked out inside the box. */
export const CHECKOUT_DIR = "/home/user/repo";

/** Cap on clamped untrusted output, in characters. */
export const OUTPUT_CLAMP_CHARS = 4_000;

/** How much stderr we keep from the started server, for a health failure. */
const STDERR_TAIL_CHARS = 8_000;

/**
 * The protocol version we offer in the health probe. Deliberately a plain
 * constant rather than the connect-form list: this probe only has to prove a
 * server is up and speaking MCP, and a server that negotiates down still
 * answers.
 */
const HEALTH_PROBE_PROTOCOL_VERSION = "2025-06-18";

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
  opts: { cwd?: string; timeoutMs: number }
): Promise<RunResult> {
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
    // Not a command failure — the sandbox itself is unreachable.
    throw new CheckStepError(
      "infra_error",
      `sandbox command failed: ${errorMessage(error)}`
    );
  }
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
  /** Most recent server stderr, for a health failure message. */
  readStderrTail: () => string;
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
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
  }
): Promise<StartedServer> {
  const build = await runForeground(
    sandbox,
    `bash -lc ${shellQuote(recipe.build)}`,
    {
      cwd: CHECKOUT_DIR,
      timeoutMs: BUILD_TIMEOUT_MS,
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

  let stderrTail = "";
  const appendStderr = (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
  };

  try {
    await sandbox.commands.run(`bash -lc ${shellQuote(recipe.start)}`, {
      cwd: CHECKOUT_DIR,
      background: true,
      onStderr: appendStderr,
    });
  } catch (error) {
    throw new CheckStepError(
      "infra_error",
      `failed to spawn the start command: ${errorMessage(error)}`
    );
  }

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
      clampOutput(stderrTail)
    );
  }

  return { url, readStderrTail: () => stderrTail };
}

/**
 * Poll the server with a real JSON-RPC `initialize` until it answers.
 *
 * A TCP connect or an HTTP 200 on `/` would be a weaker signal: a framework
 * often serves before its MCP transport is mounted, and the eval run's very
 * first act is an `initialize`. Probing with the actual handshake means "healthy"
 * means the same thing here and there.
 *
 * Accepts either a JSON body or an SSE frame — streamable-HTTP servers legally
 * answer with either.
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
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: HEALTH_PROBE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcpjam-github-checks-probe", version: "1.0.0" },
    },
  });

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
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), attemptBudgetMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
        // The same signal covers the body read below: aborting it errors the
        // response stream, so a server that sends headers and then stalls is
        // bounded too.
        signal: abort.signal,
      });
      if (response.ok && (await probeResponseIsHealthy(response))) {
        return true;
      }
    } catch {
      // Connection refused, DNS not ready, or our own abort — all expected
      // while it boots, all "not healthy yet".
    } finally {
      clearTimeout(abortTimer);
      // Tear the request down unconditionally. A streamable-HTTP server holds the
      // response stream open after answering, and we have our answer.
      abort.abort();
    }
    if (now() + intervalMs > deadline) break;
    await pause(intervalMs);
  }
  logger.warn("[github-checks] server never completed MCP initialize", {
    url,
    attempts,
  });
  return false;
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
 * initialize result, then cancel the stream. `PROBE_MAX_RESPONSE_CHARS` bounds
 * a server that streams unrelated output at us forever.
 */
async function probeResponseIsHealthy(response: Response): Promise<boolean> {
  const body = (response as { body?: unknown }).body as
    | ReadableStream<Uint8Array>
    | null
    | undefined;
  if (!body || typeof body.getReader !== "function") {
    // No streaming body available (a buffered runtime, or a test stub): the
    // payload is already in hand, so reading it cannot block.
    return looksLikeInitializeResult(await response.text());
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < PROBE_MAX_RESPONSE_CHARS) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        // Decode only what fits in the remaining budget. Decoding the whole
        // chunk first would let one large write blow past the cap — the bound
        // has to be applied to the bytes, not checked after the fact.
        const remaining = PROBE_MAX_RESPONSE_CHARS - text.length;
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        // Checked per chunk: a frame can arrive split, and a partial JSON just
        // fails to parse and waits for the rest.
        if (looksLikeInitializeResult(text)) return true;
      }
      if (done) {
        text += decoder.decode();
        return looksLikeInitializeResult(text);
      }
    }
    return looksLikeInitializeResult(text);
  } finally {
    // We are done with this response either way — a healthy server is still
    // holding the stream open, so drop it rather than leaking the socket.
    void reader.cancel().catch(() => {});
  }
}

/**
 * A successful `initialize` carries a `result` with a `protocolVersion`. An
 * error response is still a live MCP server, but not a usable one — the eval
 * run's own handshake would fail the same way, so treat it as not-yet-healthy
 * and keep polling until the deadline.
 */
function looksLikeInitializeResult(text: string): boolean {
  // SSE framing is detected by a line that STARTS with `data:`, not by the
  // substring appearing anywhere. A single-line JSON body can legitimately
  // contain "data:" inside a string (a serverInfo name, an instructions blob, a
  // tool description); treating that as SSE yielded zero payloads and a false
  // `server_unhealthy`.
  const frames = text
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  const payloads = frames.length > 0 ? frames : [text];

  for (const payload of payloads) {
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as {
        result?: { protocolVersion?: unknown };
      };
      if (parsed?.result && "protocolVersion" in (parsed.result ?? {})) {
        return true;
      }
    } catch {
      // Not JSON (a proxy's HTML error page, a partial frame) — keep looking.
    }
  }
  return false;
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
