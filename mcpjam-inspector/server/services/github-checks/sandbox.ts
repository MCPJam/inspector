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
 *   - outbound network is the same NON-GUEST PLATFORM BASELINE used by the
 *     backend: full public internet, with the three RFC1918 private ranges
 *     denied at the provider. This module passes that policy at CREATE time;
 *     the box is never narrowed afterwards. An earlier revision revoked egress
 *     entirely between the build and the start; that is deliberately gone. It
 *     defended nothing (there is no secret in the box to exfiltrate, and the
 *     clone is a public repo), it is stricter than every mainstream CI system
 *     running untrusted PR code, and it BROKE the product: a large share of MCP
 *     servers exist to proxy an external API, so their tools failed inside a
 *     check — often GREEN, because shallow assertions like
 *     `toolCalledAtLeastOnce` cannot tell a working call from an erroring one.
 *     A silent false pass is worse than the risk being defended against. The
 *     real bounds on abuse are the same ones CI uses: a short TTL and
 *     concurrency caps;
 *   - inbound eval traffic arrives through `getHost(port)`, which is why the box
 *     is created with `allowPublicTraffic: true`;
 *   - the box is ephemeral and killed after the check.
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
 * of three methods stays honest where a fake of the entire E2B surface would
 * not. Note what is NOT here: `updateNetwork`. This module never changes the
 * box's network after provisioning, and leaving the method off the interface is
 * what makes that mechanical rather than a convention.
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
 * The GitHub-checks box is non-guest, so its baseline must match the backend's
 * `resolveEgressBaseline(false)` exactly. Keep this hand-mirrored list in sync
 * with `convex/lib/computerProviders/e2b.ts`; omitting it here would silently
 * fall back to E2B's allow-all default. Link-local is intentionally not part of
 * this list because E2B uses that range for its own metadata service.
 */
export const GITHUB_CHECKS_EGRESS_DENY_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

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

/** Where the PR's BUILD writes stdout+stderr, inside the box. */
const BUILD_LOG_PATH = "/tmp/mcp-build.log";

/** Where the PR's server writes stdout+stderr, inside the box. */
const SERVER_LOG_PATH = "/tmp/mcp-server.log";
/** Cap on that file. A watchdog truncates it; see `startCommandScript`. */
const SERVER_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** How often the watchdog checks the log's size. */
const SERVER_LOG_CHECK_SECONDS = 30;

/**
 * The protocol version the legacy probe OFFERS, which is the one the eval run's
 * client offers: `_legacyHandshake` sends `legacyVersions[0]`, and an unpinned
 * connection leaves that list to the SDK's built-in `SUPPORTED_PROTOCOL_VERSIONS`,
 * whose first entry is the latest legacy revision.
 *
 * Offering something older would probe a handshake the eval never performs. A
 * server whose `2025-06-18` path works while its latest path is broken would pass
 * here and then fail the eval, and that failure would reach us as a neutral
 * `infra_error` instead of the PR's `server_unhealthy`.
 *
 * This is only what we PROPOSE. `LEGACY_PROBE_ACCEPTED_VERSIONS` is what we accept
 * back, and it stays wide, because a server that negotiates down is one the client
 * accepts too.
 */
const HEALTH_PROBE_PROTOCOL_VERSION = "2025-11-25";

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
 * Versions the LEGACY `initialize` arm will accept back from the PR's server.
 *
 * Exactly the upstream SDK's built-in legacy list, and the modern revision is
 * deliberately NOT in it. `_legacyHandshake` accepts only
 * `legacyProtocolVersions(supportedProtocolVersions)` — everything before
 * 2026-07-28 — and throws on anything else, and the eval run's unpinned
 * connection passes no list of its own, so that built-in set is the one in force.
 * Upstream keeps the two lists apart for this exact reason: "adding a revision
 * here can never leak a modern version string into a 2025-era handshake". A server
 * answering `initialize` with `2026-07-28` is one the client refuses, so accepting
 * it here would hand the PR's fault to us as a neutral `infra_error`. The modern
 * revision is reachable through `server/discover`, which is the arm that tests it.
 *
 * Hand-listed rather than imported: `check:mcp-v1-runtime-imports` forbids
 * reaching into the upstream v1 protocol SDK from inspector server code, and
 * `MCP_PROTOCOL_VERSIONS` in our own SDK is the narrower set a connection can be
 * PINNED to — it omits the legacy wire versions the client still accepts.
 *
 * The list must stay exactly as permissive as the real client. Rejecting a version
 * it accepts is a false `server_unhealthy` on a working PR; accepting one it
 * rejects lets a broken PR dodge the blame.
 */
const LEGACY_PROBE_ACCEPTED_VERSIONS: ReadonlySet<string> = new Set([
  "2024-10-07",
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

/**
 * Versions the MODERN `server/discover` arm can speak — the other side of that
 * same split.
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

/** What every redacted credential form collapses to. */
const REDACTED_CREDENTIAL = "[redacted]";

/**
 * Every `AUTHORIZATION: basic …` header, wherever it turns up.
 *
 * CONSTANT on purpose, and deliberately NOT built from the token: a secret
 * interpolated into a pattern is a secret that can carry regex metacharacters,
 * and the one time that matters is the time the redaction silently stops
 * matching. The token-derived forms are removed by literal replacement instead
 * (below); this pattern exists to catch the header AS A WHOLE — including the
 * copy an SDK echoes back inside a failing command line — so nothing survives
 * on the strength of an encoding we did not anticipate.
 *
 * The value class requires at least one character, which also makes the
 * function idempotent: `AUTHORIZATION: basic [redacted]` no longer matches.
 */
const CLONE_AUTH_HEADER_PATTERN =
  /AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=_-]+/gi;

/**
 * The base64 an installation token is sent as: `x-access-token:<token>`.
 *
 * Computed HOST-SIDE, so the token itself never appears in the command stream
 * in plaintext — only this encoding of it does, and only inside the
 * `http.extraheader` config value.
 */
function cloneAuthHeaderValue(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

/**
 * Strip a clone credential out of text that is about to be OBSERVED — thrown,
 * logged, reported as an attempt detail, or rendered on somebody's pull request.
 *
 * Three forms, because the credential reaches observable text three ways:
 *
 *   1. the RAW installation token — anything that echoes what we were handed;
 *   2. `base64(x-access-token:<token>)` — what the header actually carries;
 *   3. the whole `AUTHORIZATION: basic …` header — which is how it arrives in
 *      practice, since the E2B SDK's errors quote the command they were running
 *      and the command contains the `-c http.extraheader=…` argument verbatim.
 *
 * Applied BEFORE `clampOutput`, never after. Clamping is a length and markdown
 * boundary — it truncates, strips control characters and fences — and none of
 * that removes a secret; a clamped log tail is exactly as leaked as an unclamped
 * one.
 */
export function redactCloneCredential(
  text: string,
  token?: string | null
): string {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(
    CLONE_AUTH_HEADER_PATTERN,
    `AUTHORIZATION: basic ${REDACTED_CREDENTIAL}`
  );
  if (token) {
    // Literal, not regex: `split`/`join` treats the needle as bytes, so a token
    // containing `.` or `+` cannot quietly widen or narrow the match.
    out = out.split(cloneAuthHeaderValue(token)).join(REDACTED_CREDENTIAL);
    out = out.split(token).join(REDACTED_CREDENTIAL);
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
      // The eval run reaches the server through `getHost`. Keep public egress,
      // but apply the backend's non-guest RFC1918 baseline at creation time.
      // The network is never modified afterwards — see the module docblock.
      network: {
        allowPublicTraffic: true,
        denyOut: [...GITHUB_CHECKS_EGRESS_DENY_CIDRS],
      },
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
 * `{ envs }` when there is an environment to pass, and NOTHING otherwise.
 *
 * The empty case is the interesting one. Spreading the result of this into a
 * command's options leaves an env-free command byte-identical to what this
 * module has always sent — no `envs: undefined`, no `envs: {}` — so the
 * overwhelmingly common no-environment path cannot be changed by the existence
 * of the environment channel, and a diff of the option objects stays a diff
 * about something real.
 *
 * This is the ONLY way a recipe's environment reaches a command. It is never
 * written into a command STRING: the values come from a PR checkout, every
 * diagnostic in this module quotes commands into check output, and an `export
 * FOO=…` would additionally put author bytes inside a `bash -lc` quoting
 * boundary that is already nested two deep.
 */
function envsOption(env: Record<string, string> | undefined): {
  envs?: Record<string, string>;
} {
  return env && Object.keys(env).length > 0 ? { envs: env } : {};
}

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
    /**
     * The clone credential, when THIS command carries one. Every observable
     * form of a failure is redacted with it before anything else happens to the
     * text — in particular before `clampOutput`, which is a length boundary and
     * not a secret one.
     */
    secret?: string;
    /**
     * The recipe's declared environment, for the one command that runs the PR's
     * own code (the build). SEPARATE CONCERN FROM `secret`, in both directions:
     * these are non-secret literals from a committed file and are never
     * redacted, and the clone credential is never one of them — it rides a
     * command-line git header precisely so it does not become an environment
     * variable in a box where PR code runs.
     */
    envs?: Record<string, string>;
  }
): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    const result = (await sandbox.commands.run(command, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      ...envsOption(opts.envs),
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
        clampOutput(
          redactCloneCredential(
            `${exit.stdout ?? ""}\n${exit.stderr ?? ""}`,
            opts.secret
          )
        ) || undefined
      );
    }
    // Not a command failure — the sandbox itself is unreachable.
    //
    // THE LEAKIEST PATH IN THIS MODULE. `errorMessage` is fed the SDK's own
    // error, and an E2B transport error quotes the command it was running —
    // which, for a private clone, is the command carrying the auth header. It is
    // redacted here rather than at the caller because this is where the SDK's
    // text first becomes ours.
    throw new CheckStepError(
      "infra_error",
      `sandbox command failed: ${errorMessage(error, opts.secret)}`
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
 * Clone the PR head — anonymously for a public repository, and with a
 * short-lived, repository-scoped `contents: read` installation token for a
 * private one.
 *
 * `refs/pull/<n>/head` rather than the branch name: the branch may have been
 * renamed or deleted since the webhook fired, and the PR ref is stable. The
 * detached checkout is then ASSERTED to be exactly `headSha`. That assert is
 * load-bearing — a force-push between the webhook and the clone would otherwise
 * have us build a different tree and report the verdict against the sha in the
 * check, i.e. quietly lie about what was tested.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE CREDENTIAL GOES, AND WHERE IT DELIBERATELY DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On a command-line `-c http.extraheader=…`, on the CLONE and the FETCH, and
 * nowhere else. Every alternative was rejected for a specific reason:
 *
 *   - IN THE URL (`https://x-access-token:<t>@github.com/…`) — git writes the
 *     remote verbatim into `.git/config`, so the checkout the PR's own build
 *     then runs inside would contain the credential as a file. It also lands in
 *     `git remote -v`, in submodule resolution, and in any log that echoes the
 *     remote.
 *   - `git config --add` INSIDE the checkout — same problem by a different
 *     route: a `-c` on the command line is process-scoped and never persisted,
 *     which is the entire reason it is the mechanism here.
 *   - A CREDENTIAL HELPER, an env var, or a file — each one leaves the secret
 *     readable by whatever runs next in the box, and what runs next is the pull
 *     request's build.
 *
 * The `fetch` needs it as much as the clone does: the PR ref is a second
 * authenticated request against the same private repository, and a clone that
 * succeeds followed by a fetch that 404s is the confusing shape of forgetting
 * it. `checkout`, `rev-parse` and everything downstream are purely local and
 * get nothing.
 *
 * THE RESIDUAL, NAMED: E2B is the sandbox provider and therefore sees the
 * command stream, including this header. That is accepted rather than solved —
 * we already trust E2B with the checkout itself. What is NOT accepted is the
 * PR's own code seeing it, which is why nothing is persisted: clone and fetch
 * both finish before any PR-controlled process runs.
 */
export async function cloneAndCheckout(
  sandbox: CheckSandbox,
  args: {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    /**
     * Installation token for a PRIVATE repository. Absent ⇒ the clone is
     * anonymous, byte-for-byte as it has always been.
     */
    cloneToken?: string;
  }
): Promise<void> {
  // Unchanged, and unchanged ON PURPOSE even when a token is in play: the
  // credential travels in a header, so the URL stays the ordinary public-looking
  // HTTPS one and nothing that echoes it can leak anything.
  const cloneUrl = `https://github.com/${args.repoFullName}.git`;
  // A trailing space when present and the empty string when not, so the
  // anonymous command bytes are identical to what they were before tokens
  // existed.
  const authConfig = args.cloneToken
    ? `-c ${shellQuote(
        `http.extraheader=AUTHORIZATION: basic ${cloneAuthHeaderValue(
          args.cloneToken
        )}`
      )} `
    : "";
  const script = [
    `set -e`,
    `rm -rf ${CHECKOUT_DIR}`,
    // Shallow, but deep enough that a PR ref's own history resolves.
    `git ${authConfig}clone --depth 50 ${shellQuote(cloneUrl)} ${CHECKOUT_DIR}`,
    `cd ${CHECKOUT_DIR}`,
    `git ${authConfig}fetch --depth 50 origin ${shellQuote(
      `pull/${args.prNumber}/head`
    )}`,
    // No credential: a detached checkout is a purely local operation.
    `git checkout --detach ${shellQuote(args.headSha)}`,
  ].join(" && ");

  const result = await runForeground(
    sandbox,
    `bash -lc ${shellQuote(script)}`,
    {
      timeoutMs: CLONE_TIMEOUT_MS,
      // A repo we were just told about, and now hold a credential for, should
      // clone promptly; a stall is ours or GitHub's, matching how a non-zero
      // clone exit is attributed.
      timeoutOutcome: "infra_error",
      secret: args.cloneToken,
    }
  );
  if (result.exitCode !== 0) {
    // A repo we were just told about — and, for a private one, just minted a
    // token for — should always clone. If it doesn't, that is our problem (or
    // GitHub's), not the PR author's.
    //
    // REDACTED BEFORE CLAMPED. git prints the failing request on some errors,
    // and clamping would merely shorten the header rather than remove it.
    throw new CheckStepError(
      "infra_error",
      `clone/checkout failed (exit ${result.exitCode})`,
      clampOutput(
        redactCloneCredential(
          `${result.stdout}\n${result.stderr}`,
          args.cloneToken
        )
      )
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
 * WHO WE STARTED — captured by the SPAWN, never read back out of the box.
 *
 * This is the anchor the listener-identity check hangs off, and the whole
 * reason it is a type rather than a file: everything running inside the box
 * after `buildAndStart` is PR code, so any identity fact the box WRITES is a
 * fact the PR can forge. An earlier revision of this module had the start
 * wrapper `echo $$ > /tmp/mcp-server.pid` and read that file back; a detached
 * squatter left behind by an install hook could simply overwrite it with its
 * own pid and be recognised as "the server we spawned". The pid file is gone.
 *
 * Both fields come from our side of the boundary:
 *
 *   - `pid` is what E2B's `CommandHandle` reports for the process IT started on
 *     our behalf. Nothing inside the box participates in producing it.
 *   - `pgrp` is read from `/proc/<pid>/stat` IMMEDIATELY after the spawn, while
 *     the process we just started is the one that pid refers to. The value is
 *     the kernel's, and the pid it is keyed on is ours — so the PR cannot
 *     choose it either. Reading it later (at verification time) is what does
 *     not work: by then the supervisor may have exited, `/proc/<pid>` is gone,
 *     and the group is unrecoverable exactly in the reparented/double-forked
 *     case the group check exists to cover.
 *
 * `pgrp` is nullable, and it is null unless the spawn LEADS its group (`pgrp ===
 * pid`). A group we did not create is one other processes were already in — on
 * this image, envd puts every command in the same group — so it identifies
 * nothing. `startCommandScript` uses `setsid` to make the spawn a leader, and
 * `captureSpawnIdentity` refuses the value when that did not happen. Null
 * disables the group fallback and leaves ancestry as the only test — strictly
 * narrower, never wider.
 */
export type SpawnIdentity = {
  pid: number;
  pgrp: number | null;
};

export type StartedServer = {
  /** Public https URL of the MCP endpoint, via the sandbox host bridge. */
  url: string;
  /** Bounded tail of the server's own log, for a health failure message. */
  readStderrTail: () => Promise<string>;
  /** See `SpawnIdentity` — the only identity the verifier is allowed to trust. */
  spawn: SpawnIdentity;
};

/**
 * Build, start, and wait for the server to speak MCP.
 *
 * The step ORDER is the contract this function exists to guarantee, so it is
 * one function rather than three the caller sequences:
 *
 *   1. build
 *   2. start the server
 *   3. poll `initialize` until it answers
 *
 * The box's network is NOT touched anywhere in here. It keeps the platform
 * baseline it was provisioned with — public internet, private ranges denied —
 * for its whole life, so a server whose tools call an external API behaves the
 * same inside a check as it does anywhere else.
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
  let build: RunResult;
  try {
    build = await runForeground(
      sandbox,
      `bash -lc ${shellQuote(buildCommandScript(recipe.build))}`,
      {
        cwd: CHECKOUT_DIR,
        timeoutMs: options?.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
        timeoutOutcome: "build_failed",
        // The build gets the declared environment too, not just the start: a
        // build step that reads its configuration (a codegen flag, a fixture
        // mode) would otherwise produce a tree the start command's environment
        // no longer matches.
        ...envsOption(recipe.env),
      }
    );
  } catch (error) {
    // A build that ran out its own deadline. Its output is in the box's log, not
    // on the error, so the tail is fetched here rather than left empty.
    if (error instanceof CheckStepError && error.outcome === "build_failed") {
      throw new CheckStepError(
        error.outcome,
        error.message,
        clampOutput(await readLogTail(sandbox, BUILD_LOG_PATH)) || undefined
      );
    }
    throw error;
  }
  if (build.exitCode !== 0) {
    // The PR's own build broke. This is a check FAILURE, attributed to the PR —
    // not an infrastructure error, and not something to retry.
    throw new CheckStepError(
      "build_failed",
      `build command exited ${build.exitCode}`,
      clampOutput(await readLogTail(sandbox, BUILD_LOG_PATH))
    );
  }

  let spawnHandle: unknown;
  try {
    // Output goes to a FILE IN THE BOX, not to a stream callback. E2B's
    // `CommandHandle` appends every chunk it receives to an internal string —
    // it does that whether or not `onStderr` is supplied, and it starts doing it
    // the moment the handle is constructed. A PR server that logs continuously
    // for the twenty minutes an eval takes would therefore grow THIS process's
    // heap without limit, which no client-side ring buffer can prevent. Nothing
    // is streamed now; the tail is fetched, bounded, only if we need it.
    spawnHandle = await sandbox.commands.run(
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
        // The server's own configuration, handed to E2B beside the command
        // rather than written into it. `startCommandScript` is unchanged and
        // stays unchanged: the recipe's `start` runs in a nested `bash -lc`
        // under a watchdog, and an environment assignment threaded through that
        // would have to survive two quoting boundaries to arrive intact.
        ...envsOption(recipe.env),
      }
    );
  } catch (error) {
    throw new CheckStepError(
      "infra_error",
      `failed to spawn the start command: ${errorMessage(error)}`
    );
  }

  // Identity is settled HERE, before the PR's server has had a chance to do
  // anything, and from the spawn rather than from the box. See `SpawnIdentity`.
  const spawn = await captureSpawnIdentity(sandbox, spawnHandle);

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

  return { url, readStderrTail: readServerLogTail, spawn };
}

/** Marker the process-group read prints on. Matched, never parsed for. */
const SPAWN_PGRP_MARKER = "MCPJAM_CHECK_PGRP";

/**
 * Turn E2B's background `CommandHandle` into a `SpawnIdentity`.
 *
 * A missing or nonsensical pid is `infra_error`, not a shrug: the listener
 * check has nothing to compare against without it, and "we could not tell" must
 * never be allowed to stand in for "it was ours".
 */
async function captureSpawnIdentity(
  sandbox: CheckSandbox,
  handle: unknown
): Promise<SpawnIdentity> {
  const pid = (handle as { pid?: unknown } | null | undefined)?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new CheckStepError(
      "infra_error",
      "the sandbox did not report a pid for the start command, so nothing could verify what ends up listening"
    );
  }
  const pgrp = await readProcessGroup(sandbox, pid);
  // THE GROUP IS ONLY USABLE IF OUR SPAWN LEADS IT. A group id that is not our
  // own pid is a group that existed before we did, and on the real checks image
  // that is the common case: E2B's envd runs every command in envd's process
  // group, so the build, the clone and the start command all share one. A
  // squatter detached by a build lifecycle hook is in that group too, and
  // accepting it would hand a false green to precisely the class this check
  // exists to close (observed live — see scripts/verify-listener-identity.ts).
  // `setsid` in `startCommandScript` is what makes the spawn a leader; this is
  // the check that we actually got what it was for.
  return { pid, pgrp: pgrp === pid ? pgrp : null };
}

/**
 * The process GROUP of a pid WE were given, straight from `/proc`.
 *
 * `/proc/<pid>/stat` is `pid (comm) state ppid pgrp …` and `comm` may contain
 * spaces and parentheses, so the split starts after the LAST ')'. Node rather
 * than `ps`, for the same reason the listener walk uses node: the checks
 * template is node + git and nothing else.
 *
 * Best effort. A failure here narrows the later check (ancestry only) instead
 * of widening it, so it is not worth failing a PR over.
 */
async function readProcessGroup(
  sandbox: CheckSandbox,
  pid: number
): Promise<number | null> {
  const script =
    `const fs=require('fs');try{` +
    `const t=fs.readFileSync('/proc/${pid}/stat','utf8');` +
    `const i=t.lastIndexOf(')');` +
    `console.log('${SPAWN_PGRP_MARKER} '+t.slice(i+2).split(' ')[2]);` +
    `}catch(e){}`;
  let stdout = "";
  try {
    const result = (await sandbox.commands.run(
      `node -e ${JSON.stringify(script)}`,
      {
        timeoutMs: 30_000,
      }
    )) as { stdout?: unknown } | null;
    stdout = typeof result?.stdout === "string" ? result.stdout : "";
  } catch (error) {
    stdout =
      typeof (error as { stdout?: unknown })?.stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
  }
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${SPAWN_PGRP_MARKER} `)) continue;
    const value = Number(line.slice(SPAWN_PGRP_MARKER.length + 1).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  return null;
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
 *     stay those of the process itself. It also keeps this shell's pid — the one
 *     E2B reported to us at spawn — pointing at the server itself rather than at
 *     a wrapper that exited.
 *   - `setsid`, so the server leads a process group and session of ITS OWN. This
 *     is a correctness requirement of the identity check, not tidiness. Verified
 *     against the live checks image: E2B's envd runs EVERY command it is asked
 *     for in envd's own process group, so without this the build, the clone and
 *     the start command all share one group — and a detached squatter left by a
 *     build lifecycle hook would match the group of the server we started and be
 *     accepted as ours. `setsid` does not fork here (the shell is not already a
 *     group leader), so the pid E2B reported is preserved and becomes the group
 *     id, which is exactly the value the verifier can recognise. Guarded by a
 *     `command -v`: on an image without it the group is simply not a leader's,
 *     `captureSpawnIdentity` refuses to trust it, and the check narrows to
 *     ancestry alone.
 *   - the watchdog is a child of that shell and needs no cleanup: it dies with
 *     the sandbox, and if it dies early the only consequence is an unbounded log.
 *
 * NOTHING here records identity into the box. It used to (`echo $$ > /tmp/
 * mcp-server.pid`), and that file was writable by every process the PR starts,
 * which made it worthless as proof of who we launched. See `SpawnIdentity`.
 */
function startCommandScript(startCommand: string): string {
  // The recipe runs in its own `bash -lc`, mirroring `buildCommandScript`: the
  // redirection is applied by THIS shell (so it covers everything the recipe
  // does, not just its last simple command) and the recipe's own shell state
  // cannot reach the watchdog.
  const run = `bash -lc ${shellQuote(startCommand)} >> ${SERVER_LOG_PATH} 2>&1`;
  return [
    `: > ${SERVER_LOG_PATH}`,
    `( while :; do sleep ${SERVER_LOG_CHECK_SECONDS};` +
      ` if [ "$(wc -c < ${SERVER_LOG_PATH} 2>/dev/null || echo 0)" -gt ${SERVER_LOG_MAX_BYTES} ];` +
      ` then : > ${SERVER_LOG_PATH}; fi; done ) &`,
    // No `else`: `exec` never returns, so reaching the second line means the
    // first was not taken.
    `if command -v setsid >/dev/null 2>&1; then exec setsid ${run}; fi`,
    `exec ${run}`,
  ].join("\n");
}

/**
 * The build, with its output bounded INSIDE the box.
 *
 * Same hazard as the start path, and for the same reason: E2B's `CommandHandle`
 * accumulates every chunk it receives into an internal string, so a build script
 * that prints continuously for its ten-minute window grows THIS process's heap
 * without limit — and the build is PR-controlled code, so "it would not do that"
 * is not an assumption available here. Redirecting to a file keeps the output in
 * the sandbox, a watchdog keeps the FILE bounded so a runaway build cannot fill
 * the disk either, and only a bounded tail is ever fetched.
 *
 * The exit status has to survive all that, because it is what distinguishes a
 * broken build from a working one: the status is captured immediately, the
 * watchdog is stopped, and the captured status is what the script exits with.
 */
function buildCommandScript(buildCommand: string): string {
  return [
    `: > ${BUILD_LOG_PATH}`,
    `( while :; do sleep ${SERVER_LOG_CHECK_SECONDS};` +
      ` if [ "$(wc -c < ${BUILD_LOG_PATH} 2>/dev/null || echo 0)" -gt ${SERVER_LOG_MAX_BYTES} ];` +
      ` then : > ${BUILD_LOG_PATH}; fi; done ) &`,
    `MCPJAM_WATCHDOG=$!`,
    // The recipe runs in its OWN shell, and the redirection is applied to that
    // shell rather than to the recipe text. A redirection binds to one simple
    // command, so `npm ci && npm run build >> log` would send only `npm run
    // build`'s output to the file and let `npm ci` stream into the accumulating
    // handle — which is most of a build's output, and the whole point of the
    // redirection. Wrapping also keeps the recipe's shell state (`cd`, `exit`,
    // `set -e`) from reaching this script's watchdog cleanup.
    `bash -lc ${shellQuote(buildCommand)} >> ${BUILD_LOG_PATH} 2>&1`,
    `MCPJAM_STATUS=$?`,
    `kill $MCPJAM_WATCHDOG 2>/dev/null || :`,
    `exit $MCPJAM_STATUS`,
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
async function readLogTail(
  sandbox: CheckSandbox,
  logPath: string = SERVER_LOG_PATH
): Promise<string> {
  try {
    const result = (await sandbox.commands.run(
      `bash -lc ${shellQuote(
        `tail -c ${STDERR_TAIL_CHARS} ${logPath} 2>/dev/null || true`
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
        transportProcessesBody(response) &&
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
  // Set when the cap cut a chunk we had already been handed, which proves the body
  // is longer than what we kept. Without it, dropping those bytes and then reading
  // EOF would look exactly like a body that ended at the cap.
  let droppedBytes = false;
  try {
    while (remainingBytes > 0) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        // Decode only what fits. Decoding the whole chunk and checking after the
        // fact would let one large write blow straight past the cap. A sequence
        // cut in half here is held by the decoder (`stream: true`) and completed
        // by the next chunk, or dropped if the budget runs out first.
        const consumed = Math.min(value.byteLength, remainingBytes);
        if (consumed < value.byteLength) droppedBytes = true;
        remainingBytes -= consumed;
        text += decoder.decode(value.subarray(0, consumed), { stream: true });
        // Checked per chunk: an SSE event completes the moment its blank line
        // arrives, so waiting for the body to end would hang on a healthy server.
        if (carriesAcceptedAnswer(text, accepts, false, mode)) return true;
      }
      if (done) {
        text += decoder.decode();
        return carriesAcceptedAnswer(text, accepts, true, mode);
      }
    }
    // Out of byte budget. Reaching the cap is NOT the body ending — we stop
    // reading, the client does not — so a JSON prefix must not be judged as a whole
    // document just because it happens to parse.
    //
    // But a body measuring EXACTLY the cap has ended, and nothing so far can say
    // so: `done` never rides along with the last chunk, it takes one more read. A
    // complete answer that lands on the boundary is a working server, so refusing to
    // look would be a false `server_unhealthy` — the error worth avoiding. So take
    // that read, unless the cap already cut a chunk short (then the body is provably
    // longer and EOF here would be EOF of bytes we discarded). SSE never needs any
    // of this: an event is complete at its blank line, whatever the body does next.
    if (mode === "json" && !droppedBytes) {
      const { done } = await reader.read();
      if (done) {
        text += decoder.decode();
        return carriesAcceptedAnswer(text, accepts, true, mode);
      }
    }
    return carriesAcceptedAnswer(text, accepts, false, mode);
  } finally {
    // We are done with this response either way — a healthy server is still
    // holding the stream open, so drop it rather than leaking the socket.
    void reader.cancel().catch(() => {});
  }
}

/**
 * Whether the transport would read this response's body as an answer to the
 * request at all — as opposed to discarding it.
 *
 * `ok` is not the test. HTTP 202 is an ACKNOWLEDGEMENT: the transport drains the
 * body, throws it away, and returns before any result processing, so a handshake
 * result served with 202 never reaches the client and its `initialize` goes
 * unanswered. Accepting one here would call that server healthy and then hand its
 * failure to us as a neutral `infra_error`.
 *
 * Only 202 is excluded, not "everything but 200": the transport processes any other
 * 2xx by content type, so rejecting a 201 or 203 that carries a real answer would
 * be stricter than the client and risk a false `server_unhealthy`.
 */
function transportProcessesBody(response: Response): boolean {
  return response.ok && response.status !== 202;
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
  bodyComplete: boolean,
  mode: "json" | "sse"
): boolean {
  for (const payload of candidatePayloads(text, bodyComplete, mode)) {
    try {
      const parsed = JSON.parse(payload);
      // A BATCH, and only under `application/json`: the transport unwraps a JSON
      // array there and dispatches each element. Its SSE path parses one message
      // per event and would reject an array outright, so the asymmetry is the
      // client's, not an oversight here.
      if (mode === "json" && Array.isArray(parsed)) {
        if (batchCarriesAcceptedAnswer(parsed, accepts)) return true;
        continue;
      }
      if (accepts(parsed)) return true;
    } catch {
      // Not JSON (a proxy's HTML error page, a partial frame) — keep looking.
    }
  }
  return false;
}

/**
 * Whether a batched `application/json` body carries our answer.
 *
 * The transport maps the array through its message schema — `data.map((msg) =>
 * JSONRPCMessageSchema.parse(msg))` — so ONE malformed element throws and takes the
 * whole batch with it, our answer included. Hence the two conditions: every element
 * has to look like a JSON-RPC message, and one of them has to be the answer. An
 * empty array satisfies neither, and dispatches nothing.
 *
 * The per-element test discriminates the four arms of that union, because
 * `jsonrpc: "2.0"` alone does not: `{"jsonrpc":"2.0"}` matches none of them and
 * throws for the client, so a batch carrying one is unusable however good its
 * siblings are.
 *
 * `.strict()` is modelled too: each arm's key set is small and fixed, so a sibling
 * carrying an extra key — `result` next to `error` being the obvious one — matches
 * no arm and throws for the client. Hand-copied out of necessity, since the schema
 * is not exported from `@modelcontextprotocol/client` and
 * `@modelcontextprotocol/core` is a transitive dependency this module has no
 * business importing; the risk of that copy drifting is real but bounded, and the
 * alternative was staying knowingly looser than the transport.
 */
function batchCarriesAcceptedAnswer(
  batch: unknown[],
  accepts: (parsed: unknown) => boolean
): boolean {
  if (batch.length === 0) return false;
  if (!batch.every(isJsonRpcMessageShaped)) return false;
  return batch.some((message) => accepts(message));
}

/**
 * Whether one value matches an arm of the JSON-RPC message union: a result
 * response, an error response, or a request/notification.
 *
 * `id` is not required of a method-bearing message, because a notification
 * legitimately has none — requiring it would reject valid traffic.
 */
function isJsonRpcMessageShaped(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  const keys = Object.keys(message);
  // Every arm is STRICT, so an arm matches only when the key set is within what it
  // allows. That is what makes `result` next to `error` a violation rather than a
  // curiosity, and why each branch checks keys and not just its discriminator.
  const within = (allowed: readonly string[]) =>
    keys.every((key) => allowed.includes(key));
  // `RequestIdSchema` is `string | int` — `null` is not an id, and neither is a
  // fractional number.
  const idIsValid =
    typeof message.id === "string" ||
    (typeof message.id === "number" && Number.isInteger(message.id));
  // `params` is a LOOSE object where it appears, so being an object is all of it.
  const paramsAreShaped =
    message.params === undefined || isPlainObject(message.params);

  if (message.result !== undefined) {
    return (
      within(RESULT_RESPONSE_KEYS) &&
      idIsValid &&
      isResultShaped(message.result)
    );
  }
  if (message.error !== undefined) {
    if (!within(["jsonrpc", "id", "error"])) return false;
    // `id` is OPTIONAL on this arm, but a present one still has to be an id.
    if (message.id !== undefined && !idIsValid) return false;
    if (!isPlainObject(message.error)) return false;
    const error = message.error as { code?: unknown; message?: unknown };
    return (
      typeof error.code === "number" &&
      Number.isInteger(error.code) &&
      typeof error.message === "string"
    );
  }
  if (typeof message.method !== "string") return false;
  // Request when it carries an id, notification when it does not. The notification
  // arm is strict and has no `id` at all, so a message with an INVALID id matches
  // neither arm — it is not a notification with a stray key, and not a request.
  if (message.id === undefined) {
    return within(["jsonrpc", "method", "params"]) && paramsAreShaped;
  }
  return (
    within(["jsonrpc", "id", "method", "params"]) &&
    idIsValid &&
    paramsAreShaped
  );
}

/**
 * The candidate JSON payloads in the body, framed the way its declared media
 * type says to frame them.
 *
 * `bodyComplete` says the body ENDED — not merely that we stopped reading it. Only
 * the JSON side cares: SSE payloads are complete events, and an event is complete
 * when its blank line arrives, whatever the body does afterwards.
 */
function candidatePayloads(
  text: string,
  bodyComplete: boolean,
  mode: "json" | "sse"
): string[] {
  return mode === "sse" ? ssePayloads(text) : jsonPayloads(text, bodyComplete);
}

/**
 * The one candidate payload in an `application/json` body: the whole body.
 *
 * Withheld until the body is complete, because `response.json()` is what the
 * transport calls and that needs the whole thing. Deciding early would also let
 * a server whose body is one valid JSON document followed by more content (a
 * second document, trailing junk) be accepted at the instant the first document
 * lands — and `response.json()` rejects exactly that, so the client would fail
 * where the probe passed. That includes the byte cap: a prefix that parses is
 * still a prefix, and the client reads past where we stopped.
 */
function jsonPayloads(text: string, bodyComplete: boolean): string[] {
  if (!bodyComplete) return [];
  const document = text.trim();
  return document ? [document] : [];
}

/**
 * The candidate JSON payloads in a `text/event-stream` body: the data of each
 * complete event.
 *
 * Only events the transport would actually dispatch count: unnamed or named
 * `message` (see `flush`), and carrying data.
 *
 * A payload comes only from a `data` FIELD — a body under this media type that
 * carries no such field carries no events, and the transport's EventSource parser
 * would surface nothing to the client no matter how valid the JSON in it looks.
 * (Which is also why "data:" appearing INSIDE a JSON string — a serverInfo name,
 * an instructions blob, a tool description — is not a field: field names are read
 * from the start of a line, never matched as a substring.)
 *
 * Within one event, consecutive `data:` fields are JOINED with newlines, per SSE
 * semantics. A server that spreads one JSON-RPC message across several fields is
 * legal, and parsing each line on its own made every fragment fail to parse.
 *
 * An event is dispatched on its terminating BLANK LINE and at no other moment.
 * Nothing here depends on whether the body has ended, because nothing in the
 * transport does: `EventSourceParserStream` is a `TransformStream` with no `flush`,
 * so a pending event with no blank line after it is dropped when the stream closes
 * rather than delivered. An unterminated tail is therefore never a payload — not
 * mid-stream, not at EOF, not when the byte cap stops us. Withholding it also keeps
 * a multi-field event from being handed to `JSON.parse` a field short, which mostly
 * just fails to parse but would otherwise accept a server whose first field happens
 * to be a complete JSON object followed by more fields.
 */
function ssePayloads(text: string): string[] {
  const payloads: string[] = [];
  let current: string[] = [];
  let eventName = "";
  const flush = () => {
    // The transport dispatches an event's data only when the event is UNNAMED or
    // named `message`; anything else (`event: ping`, `event: error`, a server's
    // own progress channel) is dropped before it reaches the JSON parser. So a
    // handshake answer smuggled inside a named event never arrives, the eval
    // run's `initialize` goes unanswered, and reading it here would hand the PR's
    // fault to us as a neutral `infra_error`. An empty `event:` value counts as
    // unnamed, which is also how the spec dispatches it.
    if (current.length > 0 && (eventName === "" || eventName === "message")) {
      payloads.push(current.join("\n"));
    }
    current = [];
    eventName = "";
  };

  // LF, CRLF and bare CR are all legal SSE line separators, and a leading BOM is
  // stripped before parsing — that is what the transport's EventSource parser
  // does, so a server it can drive must not be turned away here. Splitting on LF
  // alone left a CR-separated frame unrecognised and the probe timed out.
  const segments = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  // The final segment is whatever follows the last separator, so it is a PARTIAL
  // line, not a line — a half-written `data:` field, or the empty tail left by a
  // trailing separator. Neither is a line the parser has seen, and treating the
  // empty tail as a line would read it as a blank-line terminator and dispatch an
  // event the server has not finished. A REAL terminator shows up as an empty
  // segment with another segment after it, so a properly terminated event is always
  // inside this bound. (A CRLF split across chunk boundaries is safe because the
  // whole accumulated text is re-split on every read, never appended to a previous
  // parse.)
  const lineCount = segments.length - 1;
  for (let index = 0; index < lineCount; index += 1) {
    const line = segments[index];
    // A blank line ends the event, and is the ONLY thing that does. Checked first
    // because the parser reaches its dispatch before it ever looks at fields.
    if (line === "") {
      flush();
      continue;
    }
    const [field, value] = sseField(line);
    if (field === "data") {
      current.push(value);
      continue;
    }
    if (field === "event") {
      // Last one wins within an event, per the spec.
      eventName = value;
      continue;
    }
    // `id`, `retry`, a comment, an unknown field: carries no data, and does not
    // split the event either. (Unknown fields are reported to an `onError` the
    // transport does not pass, so they are ignored rather than fatal.)
  }
  return payloads.filter((payload) => payload.length > 0);
}

/**
 * One SSE line split into field name and value, by the transport's parser's rules.
 *
 * The name runs to the first colon and the value is what follows, minus ONE
 * optional space — not trimmed. That matters for `event:`: the parser keeps the
 * rest of the whitespace, so `event: message ` is the event type `"message "`,
 * which is not `"message"` and is therefore dropped. A trim would normalise it and
 * accept an answer the eval run never receives. For `data:` the difference is
 * invisible to `JSON.parse`, but fields are joined verbatim, so the same rule keeps
 * a multi-field payload's text intact.
 *
 * A line with NO colon is that field with an EMPTY value, not a line to skip. So a
 * bare `event` CLEARS the event type (`eventType = value || void 0` in the parser)
 * and the next dispatch is an unnamed `message` — it does not inherit the name from
 * an earlier `event:` line. Skipping the line kept the stale name and discarded an
 * answer the client does receive, which is a false `server_unhealthy`.
 *
 * A leading colon makes the name empty, which is how comments fall through to being
 * ignored.
 */
function sseField(line: string): [string, string] {
  const separator = line.indexOf(":");
  if (separator === -1) return [line, ""];
  const value = line.slice(separator + 1);
  return [
    line.slice(0, separator),
    value.startsWith(" ") ? value.slice(1) : value,
  ];
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
 *   - `protocolVersion` the client can speak IN THIS ERA — a modern revision here
 *     is refused by the legacy handshake, so it is not usable evidence;
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
    !LEGACY_PROBE_ACCEPTED_VERSIONS.has(initialize.protocolVersion)
  ) {
    return false;
  }
  if (!isUsableCapabilities(initialize.capabilities)) return false;
  return isServerIdentity(initialize.serverInfo);
}

/**
 * The capability fields typed as objects by the shape a server is expected to send.
 *
 * This is the LEGACY arm's check, and it is deliberately shallow. `_legacyHandshake`
 * assigns `result.capabilities` straight through without running a schema over it
 * — the JSON-RPC envelope validates `result` as a loose object and stops there — so
 * nothing below is forced by the client on this path. Nested field types are
 * mirrored only on the discover arm, where the client really does run
 * `ServerCapabilitiesSchema`.
 *
 * A closed list rather than "every value must be an object": the capabilities shape
 * passes unknown keys through untouched, so a server advertising some extension as
 * a bare string is still one the eval run can drive. Rejecting it here would be
 * stricter than the client — a false `server_unhealthy` on a working PR, which is
 * the failure this whole predicate exists to avoid.
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
 *   - `capabilities` and `instructions` as the MODERN discover result schema types
 *     them, which is not the same schema the legacy arm's era uses.
 *
 * Unlike the legacy arm, this one has a schema to mirror and mirrors it. The client
 * runs the discover result through `codecForVersion(...).validateResult`, and a
 * result that FAILS is classified `legacy` — the connection falls back to
 * `initialize` rather than erroring. So a payload rejected here is not necessarily
 * a dead server; it is a server the client will not drive in the modern era, which
 * is precisely what this arm is asked about. The legacy arm answers the rest.
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
    instructions?: unknown;
  };
  if (!Array.isArray(discover.supportedVersions)) return false;
  const offered = discover.supportedVersions.filter(
    (version): version is string => typeof version === "string"
  );
  if (offered.length !== discover.supportedVersions.length) return false;
  if (!offered.some((version) => MODERN_PROBE_ACCEPTED_VERSIONS.has(version))) {
    return false;
  }
  if (
    discover.instructions !== undefined &&
    typeof discover.instructions !== "string"
  ) {
    return false;
  }
  return matchesServerCapabilitiesSchema(discover.capabilities);
}

/**
 * The capability fields whose nested flags the schema types as booleans.
 */
const CAPABILITY_BOOLEAN_FLAGS: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ["tools", ["listChanged"]],
  ["prompts", ["listChanged"]],
  ["resources", ["subscribe", "listChanged"]],
];

/**
 * Whether `capabilities` would survive the schema the client validates a
 * `server/discover` result with.
 *
 * That schema is `ServerCapabilities2026Schema`, reached through
 * `codecForVersion(MODERN_WIRE_REVISION).validateResult("server/discover", …)` —
 * the rev2026 codec. NOT the `ServerCapabilitiesSchema` that the 2025 codec uses
 * for `initialize`. The two are close but not identical, and the difference is
 * load-bearing: the 2026 schema is built from the SEVEN shared members below and
 * omits `tasks` entirely, so a modern server advertising `tasks` in any shape at
 * all has it stripped as an unknown member and negotiates fine. Validating it here
 * rejected servers the client drives — a false `server_unhealthy`.
 *
 * Mirrored field by field rather than shape-only, because the schema does type the
 * nesting of the members it defines: `tools: { listChanged: "yes" }` and
 * `extensions: true` are both objects at the top level and both rejected a level
 * down. A probe that stops at "is it an object" reports the modern arm healthy for
 * a server the client declines to drive there.
 *
 * Unknown keys stay welcome, at every level the schema leaves open: the capability
 * objects are non-strict, so extra members are ignored rather than fatal, and
 * capabilities is explicitly "not a closed set". Only the members it gives a type
 * are checked. `JSONObject`-typed fields need only be objects — anything that came
 * off the wire as JSON already satisfies the value type.
 *
 * The result's own `ttlMs` and `cacheScope` are not checked either: the modern
 * schema declares them with `.catch(…)`, so a malformed value is replaced with a
 * default and can never fail validation. Checking them would be strictly stricter
 * than the client.
 */
function matchesServerCapabilitiesSchema(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const capabilities = value as Record<string, unknown>;

  for (const field of ["logging", "completions"] as const) {
    const capability = capabilities[field];
    if (capability !== undefined && !isPlainObject(capability)) return false;
  }

  // Name-keyed maps of objects, not free-form values.
  for (const field of ["experimental", "extensions"] as const) {
    const record = capabilities[field];
    if (record === undefined) continue;
    if (!isPlainObject(record)) return false;
    const entries = Object.values(record as Record<string, unknown>);
    if (!entries.every((entry) => isPlainObject(entry))) return false;
  }

  for (const [field, flags] of CAPABILITY_BOOLEAN_FLAGS) {
    const capability = capabilities[field];
    if (capability === undefined) continue;
    if (!isPlainObject(capability)) return false;
    const flagged = capability as Record<string, unknown>;
    const flagsAreBooleans = flags.every(
      (flag) =>
        flagged[flag] === undefined || typeof flagged[flag] === "boolean"
    );
    if (!flagsAreBooleans) return false;
  }

  // `tasks` is deliberately NOT checked. The modern schema does not define it, so
  // it is an unknown member like any other and is stripped, not rejected — see the
  // note above about which schema is actually in force here.
  return true;
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
  if (!isResultShaped(message.result)) return null;
  // The result-response arm is `{ jsonrpc, id, result }` and it is STRICT, so a
  // fourth key means the envelope matches no arm of the union and the transport
  // throws on it — `result` alongside `error` or `method` most obviously, but any
  // extra key does it. An envelope the client cannot parse is not an answer,
  // however good the result inside it looks, and accepting one would hand the PR's
  // fault to us as a neutral `infra_error`.
  return RESULT_RESPONSE_KEYS.length === Object.keys(message).length
    ? (message.result as object)
    : null;
}

/**
 * Whether a `result` payload satisfies the envelope's result schema.
 *
 * `ResultSchema` is a loose object with an OPTIONAL `_meta` that must itself be an
 * object, so `_meta: true` fails the envelope parse before any handshake logic
 * runs — the client never looks at the rest of the result. Everything else inside
 * passes through, which is why this checks `_meta` and nothing more.
 */
function isResultShaped(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const meta = (value as { _meta?: unknown })._meta;
  return meta === undefined || isPlainObject(meta);
}

/** Every key the strict result-response arm allows, and it requires all three. */
const RESULT_RESPONSE_KEYS = ["jsonrpc", "id", "result"] as const;

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

/**
 * Single-quote for `bash -lc`, so a repo name, a sha or a path can never inject.
 *
 * Exported because `sandbox-inspect.ts` quotes the same way against the same
 * shell, and two hand-rolled implementations of a security-sensitive escape is
 * one more than the number that can be reviewed.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * An error's text, with any clone credential already removed.
 *
 * Redaction happens BEFORE the slice, deliberately: slicing first can cut a
 * token in half, and half a token in a log is still half a token in a log —
 * and no longer matches the literal the redaction is looking for.
 *
 * The `secret` is optional because most callers run commands that never carry
 * one. They still get the constant header sweep, which costs nothing and means
 * a future command that grows an `AUTHORIZATION:` header is covered the day it
 * is written rather than the day somebody remembers.
 */
function errorMessage(error: unknown, secret?: string | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactCloneCredential(raw, secret);
  return error instanceof Error ? redacted.slice(0, 300) : redacted;
}
