import { describe, expect, it, vi } from "vitest";
import {
  buildAndStart,
  CHECK_SANDBOX_TIMEOUT_MS,
  CheckStepError,
  clampOutput,
  cloneAndCheckout,
  OUTPUT_CLAMP_CHARS,
  redactCloneCredential,
  PROBE_MAX_RESPONSE_BYTES,
  waitForMcpInitialize,
  type CheckSandbox,
} from "../sandbox";
import { listRecipeRepos, lookupRecipe, resolveCheckRecipe } from "../recipes";

// Everything this module runs is untrusted PR code, so the tests are written
// around the two properties that make that safe rather than around happy-path
// plumbing:
//
//   1. the box's NETWORK IS NEVER TOUCHED after provisioning. It keeps the
//      platform baseline (public internet, private ranges denied) for its whole
//      life, so a server whose tools call an external API behaves the same
//      inside a check as anywhere else. The fake still EXPOSES `updateNetwork`
//      even though `CheckSandbox` no longer declares it, precisely so a
//      reintroduced lockdown would show up in the event log and fail a test
//      rather than pass unnoticed;
//   2. failures are attributed correctly — a broken build is the PR's
//      (`build_failed`), an unreachable E2B is ours (`infra_error`) — because
//      the attribution is what decides whether someone gets a red X.

const RECIPE = {
  build: "npm ci && npm run build",
  start: "npm start",
  port: 3001,
  mcpPath: "/mcp",
};

type Call = { command: string; opts?: Record<string, unknown> };

/**
 * Fake sandbox recording an ordered log of everything that happened, so
 * ordering assertions are about the real sequence and not a mocked promise.
 */
function fakeSandbox(options?: {
  exitCodes?: Record<string, number>;
  stdout?: Record<string, string>;
  stderr?: Record<string, string>;
  throwOn?: (command: string) => unknown;
  /** Emitted on the background command's stderr the moment it is spawned. */
  stderrOnSpawn?: string[];
}) {
  const events: string[] = [];
  const calls: Call[] = [];
  let stderrSink: ((data: string) => void) | undefined;

  const matchKey = (command: string, table?: Record<string, unknown>) => {
    if (!table) return undefined;
    return Object.keys(table).find((key) => command.includes(key));
  };

  // TRIPWIRE, not plumbing: `CheckSandbox` no longer declares `updateNetwork`,
  // and production code has no way to call it. The fake keeps it so that if a
  // future change ever puts a network mutation back into this module, it lands
  // in `events` and the "never modifies the network" test goes red on purpose.
  const sandbox: CheckSandbox & {
    updateNetwork(network: Record<string, unknown>): Promise<void>;
  } = {
    sandboxId: "sb_test",
    getHost: (port: number) => `${port}-sb_test.e2b.app`,
    commands: {
      run: async (command, opts) => {
        calls.push({ command, opts });
        events.push(opts?.background ? `spawn:${command}` : `run:${command}`);

        const thrown = options?.throwOn?.(command);
        if (thrown) throw thrown;

        if (opts?.background) {
          stderrSink = opts.onStderr;
          for (const chunk of options?.stderrOnSpawn ?? []) {
            stderrSink?.(chunk);
          }
          return { pid: 1234 };
        }

        const exitKey = matchKey(command, options?.exitCodes);
        const exitCode = exitKey ? options!.exitCodes![exitKey] : 0;
        const outKey = matchKey(command, options?.stdout);
        const errKey = matchKey(command, options?.stderr);
        const result = {
          exitCode,
          stdout: outKey ? options!.stdout![outKey] : "",
          stderr: errKey ? options!.stderr![errKey] : "",
        };
        if (exitCode !== 0) {
          // E2B throws on non-zero exit, carrying the streams on the error.
          throw Object.assign(new Error("command exited non-zero"), result);
        }
        return result;
      },
    },
    updateNetwork: async (network) => {
      events.push(`network:${JSON.stringify(network)}`);
    },
    kill: async () => {
      events.push("kill");
    },
  };

  return {
    sandbox,
    events,
    calls,
    emitStderr: (chunk: string) => stderrSink?.(chunk),
  } as const;
}

/**
 * Undo the outer `bash -lc '<script>'` quoting so a test can assert on the script
 * itself rather than on its escaped form. Nested quoting is correct but unreadable:
 * an inner `'...'` arrives as `'\''...'\''`.
 */
function scriptOf(command: string): string {
  const match = /^bash -lc '([\s\S]*)'$/.exec(command);
  if (!match) throw new Error(`not a quoted bash -lc command: ${command}`);
  return match[1].replace(/'\\''/g, "'");
}

/**
 * A COMPLETE initialize result. The probe mirrors the real client, which
 * validates the JSON-RPC envelope and `InitializeResultSchema` — so a fixture
 * missing `capabilities` or `serverInfo` is not a server the eval run could
 * have used either.
 */
const INITIALIZE_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "fixture", version: "1.0.0" },
} as const;

const SSE_INITIALIZE_FRAME = `event: message\ndata: ${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: INITIALIZE_RESULT,
})}\n\n`;

function okInitialize(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/**
 * A complete, valid initialize answer padded to measure EXACTLY
 * `PROBE_MAX_RESPONSE_BYTES`, so the probe's byte cap lands on the last byte of a
 * parseable document. All ASCII, so characters and bytes agree.
 */
function cappedDocument(): string {
  // The padding goes INSIDE `result`, where the result schema is loose. At the top
  // level it would be a fourth key on a strict arm — an envelope the transport
  // rejects, and one the probe therefore rejects too.
  const answer = {
    jsonrpc: "2.0",
    id: 1,
    result: { ...INITIALIZE_RESULT, pad: "" },
  };
  const padding = PROBE_MAX_RESPONSE_BYTES - JSON.stringify(answer).length;
  if (padding <= 0) throw new Error("initialize fixture exceeds the probe cap");
  const document = JSON.stringify({
    ...answer,
    result: { ...answer.result, pad: "a".repeat(padding) },
  });
  if (document.length !== PROBE_MAX_RESPONSE_BYTES) {
    throw new Error(`padded to ${document.length}, not the cap`);
  }
  return document;
}

/**
 * A server that has no `initialize` and answers `server/discover` with the given
 * capabilities — the modern arm in isolation, so a capability-shape verdict is not
 * masked by the legacy arm accepting the same server.
 */
function discoverCapabilitiesFetch(
  capabilities: unknown,
  instructions?: unknown
): typeof fetch {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const parsed = JSON.parse(String(init.body)) as { method: string };
    if (parsed.method === "initialize") {
      return new Response("{}", {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities,
          ...(instructions === undefined ? {} : { instructions }),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof fetch;
}

describe("buildAndStart", () => {
  it("builds BEFORE it starts the server", async () => {
    const box = fakeSandbox();
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;

    const started = await buildAndStart(box.sandbox, RECIPE, { fetchImpl });

    const buildIndex = box.events.findIndex((e) => e.includes("npm run build"));
    const spawnIndex = box.events.findIndex((e) => e.startsWith("spawn:"));

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(spawnIndex).toBeGreaterThan(buildIndex);
    expect(started.url).toBe("https://3001-sb_test.e2b.app/mcp");
  });

  it("never modifies the sandbox's network", async () => {
    // The box keeps the network it was PROVISIONED with — public internet,
    // private ranges denied by the platform baseline — for its whole life.
    // This replaces an earlier egress lockdown that ran between the build and
    // the start. It protected nothing (no credentials in the box, public-repo
    // clone) while breaking every MCP server that proxies an external API,
    // often GREEN because shallow assertions cannot tell a working tool call
    // from an erroring one. Reintroducing one has to fail this test first.
    const box = fakeSandbox();
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;

    await buildAndStart(box.sandbox, RECIPE, { fetchImpl });

    expect(box.events.filter((e) => e.startsWith("network:"))).toEqual([]);
  });

  it("attributes a non-zero build to the PR, with a clamped log tail", async () => {
    const box = fakeSandbox({
      exitCodes: { "npm run build": 1 },
      // The build's own output never crosses into this process — it is redirected
      // to a file in the box, and only a bounded `tail -c` of it is fetched.
      stdout: { "tail -c": "npm ERR! missing script: build" },
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    }).catch((e) => e as CheckStepError);

    expect(error).toBeInstanceOf(CheckStepError);
    expect((error as CheckStepError).outcome).toBe("build_failed");
    expect((error as CheckStepError).detailsMarkdown).toContain(
      "missing script: build"
    );
    // A failed build means no server and no egress change to make.
    expect(box.events.some((e) => e.startsWith("spawn:"))).toBe(false);
    expect(box.events.some((e) => e.startsWith("network:"))).toBe(false);
  });

  it("reports server_unhealthy with the server’s log tail when initialize never lands", async () => {
    // The started process complains in its log while the probe keeps failing.
    const box = fakeSandbox({
      stdout: { "tail -c": "Error: listen EADDRINUSE 127.0.0.1:3001" },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl,
      healthTimeoutMs: 30,
      healthIntervalMs: 1,
    }).catch((e) => e as CheckStepError);
    expect((error as CheckStepError).outcome).toBe("server_unhealthy");
    expect((error as CheckStepError).detailsMarkdown).toContain("EADDRINUSE");
  });

  it("keeps the BUILD's output inside the box, never streaming it to us", async () => {
    // The same hazard the start path already guards: E2B's command handle
    // accumulates every chunk it receives into an internal string, so a build
    // script that prints for its whole ten-minute window would grow THIS process's
    // heap without limit — and the build is PR-controlled code. The output must be
    // redirected in the box and only a bounded tail fetched.
    const box = fakeSandbox();
    await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });

    const buildCall = box.calls.find((call) =>
      call.command.includes("npm run build")
    );
    expect(buildCall).toBeDefined();
    // Redirected to a file, with a watchdog bounding that file too.
    const script = scriptOf(buildCall!.command);
    expect(script).toContain("/tmp/mcp-build.log");
    expect(script).toContain("wc -c");
    // The WHOLE recipe is redirected, not just its last command. A redirection
    // binds to one simple command, so `npm ci && npm run build >> log` would leave
    // `npm ci` — most of the output — streaming into the accumulating handle.
    expect(script).toContain(
      `bash -lc '${RECIPE.build}' >> /tmp/mcp-build.log 2>&1`
    );
    // No stream callbacks: supplying one is what makes the handle buffer eagerly.
    expect(buildCall!.opts?.onStdout).toBeUndefined();
    expect(buildCall!.opts?.onStderr).toBeUndefined();
    // And the build's exit status still has to survive the redirection, or a
    // broken build would read as a passing one.
    expect(script).toContain("exit $MCPJAM_STATUS");
  });

  it("attributes a build that runs out its deadline to the PR, not to us", async () => {
    // E2B reports a command deadline as a TimeoutError with no exit code, which
    // lands in the transport branch and concludes `neutral` — letting a hanging
    // (or deliberately hanging) build dodge a red check.
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm run build")
          ? Object.assign(new Error("deadline exceeded"), {
              name: "TimeoutError",
            })
          : undefined,
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      // Zero deadline: whatever happens, the elapsed time has reached it.
      buildTimeoutMs: 0,
    }).catch((e) => e as CheckStepError);

    expect((error as CheckStepError).outcome).toBe("build_failed");
    // And still no server, and no egress change.
    expect(box.events.some((e) => e.startsWith("spawn:"))).toBe(false);
  });

  it("keeps an E2B failure that merely looks like a timeout as infra_error", async () => {
    // E2B raises `TimeoutError` for Unavailable and Canceled RPCs too, not only
    // for a command deadline. Trusting the error's name would report an E2B
    // outage during `npm ci` as the PR's broken build — a red X on a good PR.
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm run build")
          ? Object.assign(
              new Error(
                "sandbox is unavailable: This error is likely due to sandbox timeout."
              ),
              { name: "TimeoutError" }
            )
          : undefined,
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      // A deadline the failure cannot plausibly have reached.
      buildTimeoutMs: 10 * 60_000,
    }).catch((e) => e as CheckStepError);

    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("still says infra_error when an E2B outage surfaces AFTER the deadline", async () => {
    // The other direction: a spent clock must not turn an outage into the PR's
    // failure just because it arrived late. E2B's own description of the failure
    // closes the door the clock opened.
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm run build")
          ? Object.assign(
              new Error(
                "connection error: This error is likely due to exceeding 'requestTimeoutMs'."
              ),
              { name: "TimeoutError" }
            )
          : undefined,
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      buildTimeoutMs: 0,
    }).catch((e) => e as CheckStepError);

    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("takes the start command's identity FROM THE SPAWN, and writes no pid file", async () => {
    // The finding this replaces: the wrapper used to `echo $$ > /tmp/
    // mcp-server.pid` and the verifier read that file back. Everything running
    // in the box after the build is PR code, so a detached squatter could
    // overwrite the file with its own pid and be recognised as the process we
    // started. Identity now comes from E2B's handle plus a kernel read keyed on
    // that handle's pid — neither of which the box authors.
    const box = fakeSandbox({
      stdout: { "/proc/1234/stat": "MCPJAM_CHECK_PGRP 1234\n" },
    });
    const started = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });

    expect(started.spawn).toEqual({ pid: 1234, pgrp: 1234 });
    // Nothing anywhere in the sequence touches a pid file.
    expect(box.calls.every((call) => !call.command.includes(".pid"))).toBe(
      true
    );
    // And the process group is read for the pid the HANDLE reported, not for
    // some pid the box named.
    expect(
      box.calls.some((call) => call.command.includes("/proc/1234/stat"))
    ).toBe(true);
  });

  it("captures the process group BEFORE the health probe, not at verification time", async () => {
    // The whole point of capturing it at spawn: the shape the group fallback
    // exists for is a supervisor that EXITS, and once it has, `/proc/<pid>` is
    // gone and the group is unrecoverable. So the read has to happen while the
    // spawned process is still the thing that pid refers to.
    const box = fakeSandbox({
      stdout: { "/proc/1234/stat": "MCPJAM_CHECK_PGRP 1234\n" },
    });
    await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });

    const spawnIndex = box.events.findIndex((e) => e.startsWith("spawn:"));
    const pgrpIndex = box.events.findIndex((e) =>
      e.includes("/proc/1234/stat")
    );
    expect(spawnIndex).toBeGreaterThanOrEqual(0);
    expect(pgrpIndex).toBeGreaterThan(spawnIndex);
  });

  it("refuses a process group our spawn does not LEAD", async () => {
    // Observed against the live checks image: E2B's envd runs every command it
    // is given in envd's own process group, so the build, the clone and the
    // start command all share one — and a squatter detached by a build
    // lifecycle hook matched the server we started. A group id that is not our
    // pid is a group that predates us, so it identifies nobody.
    const box = fakeSandbox({
      stdout: { "/proc/1234/stat": "MCPJAM_CHECK_PGRP 317\n" },
    });
    const started = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });
    expect(started.spawn).toEqual({ pid: 1234, pgrp: null });
  });

  it("puts the server in a session of its own, so the group can mean something", async () => {
    // `setsid` is what makes the spawn a group leader; without it the leader
    // check above would null the group on every run and the double-fork case
    // would have no way home. Guarded, so an image without setsid degrades to
    // ancestry rather than failing to start.
    const box = fakeSandbox();
    await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });
    const spawn = box.calls.find((call) => call.opts?.background === true);
    expect(spawn?.command).toContain("command -v setsid");
    expect(spawn?.command).toContain("exec setsid");
    // And a fallback that still starts the server on an image without it.
    expect(spawn?.command).toMatch(/fi\nexec bash -lc/);
  });

  it("narrows rather than widens when the process group cannot be read", async () => {
    // A failed read leaves ancestry as the only test. Never a guess, and never
    // a value the box supplied instead.
    const box = fakeSandbox();
    const started = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });
    expect(started.spawn).toEqual({ pid: 1234, pgrp: null });
  });

  it("is infra_error — never a pass — when E2B reports no pid for the spawn", async () => {
    const box = fakeSandbox();
    // The handle came back without a usable pid: there is nothing to compare a
    // listener against, and "could not tell" must not stand in for "it is ours".
    (box.sandbox.commands as { run: unknown }).run = async (
      command: string,
      opts?: { background?: boolean }
    ) => (opts?.background ? {} : { exitCode: 0, stdout: "", stderr: "" });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    }).catch((e) => e as CheckStepError);
    expect((error as CheckStepError).outcome).toBe("infra_error");
    expect((error as CheckStepError).message).toContain("did not report a pid");
  });

  it("gives the PR's server a timeout covering the sandbox lifetime", async () => {
    // E2B's `timeoutMs` defaults to 60 SECONDS and applies to background
    // commands too, so an unset value kills the server (and its stderr stream)
    // about a minute in — mid-suite, as a false failure.
    const box = fakeSandbox();
    await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });

    const spawn = box.calls.find((call) => call.opts?.background === true);
    expect(spawn).toBeDefined();
    expect(spawn?.opts?.timeoutMs).toBe(CHECK_SANDBOX_TIMEOUT_MS);
    // Not 0: E2B forwards it to connect-rpc, which treats <= 0 as an expired
    // deadline and would abort the spawn instantly.
    expect(spawn?.opts?.timeoutMs).toBeGreaterThan(0);
  });

  it("treats a sandbox that cannot run commands at all as infra_error", async () => {
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm") ? new Error("sandbox is gone") : undefined,
    });
    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    }).catch((e) => e as CheckStepError);
    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("bounds a firehose of server output INSIDE the box, and clamps what arrives", async () => {
    // E2B's CommandHandle buffers every chunk it receives into an internal
    // string, from the moment the handle exists and regardless of callbacks. A PR
    // server that logs for twenty minutes would grow this process's heap without
    // limit, so nothing is streamed: output goes to a file and only a bounded
    // tail is ever fetched.
    const box = fakeSandbox({
      stdout: { "tail -c": `${"x".repeat(50_000)}THE-LAST-LINE` },
    });
    const error = (await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => {
        throw new Error("refused");
      }) as unknown as typeof fetch,
      healthTimeoutMs: 30,
      healthIntervalMs: 1,
    }).catch((e) => e)) as CheckStepError;

    // The spawn streams nothing back and appends to a file…
    const spawn = box.calls.find((call) => call.opts?.background === true);
    expect(spawn?.command).toContain(">> /tmp/mcp-server.log 2>&1");
    expect(spawn?.opts?.onStderr).toBeUndefined();
    expect(spawn?.opts?.onStdout).toBeUndefined();
    // …with a watchdog so the file cannot fill the sandbox's disk either, which
    // would take down the very server being evaluated.
    expect(spawn?.command).toContain("wc -c < /tmp/mcp-server.log");
    expect(spawn?.command).toContain("4194304");
    // …and the truncation is done by the sandbox, not after the fact.
    expect(
      box.calls.some((call) => call.command.includes("tail -c 8000"))
    ).toBe(true);
    // Whatever still comes back is clamped before it can reach a check body.
    expect(error.detailsMarkdown).toContain("THE-LAST-LINE");
    expect(error.detailsMarkdown!.length).toBeLessThan(
      OUTPUT_CLAMP_CHARS + 200
    );
  });
});

describe("cloneAndCheckout", () => {
  it("clones anonymously from the PR ref and asserts the resolved sha", async () => {
    const headSha = "a".repeat(40);
    const box = fakeSandbox({ stdout: { "rev-parse HEAD": `${headSha}\n` } });

    await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/mcp-check-fixture",
      prNumber: 7,
      headSha,
    });

    const cloneCall = box.calls[0].command;
    expect(cloneCall).toContain(
      "https://github.com/mcpjam/mcp-check-fixture.git"
    );
    expect(cloneCall).toContain("pull/7/head");
    expect(cloneCall).toContain("git checkout --detach");
    expect(cloneCall).toContain(headSha);
    // No credential of any kind reaches the box.
    expect(cloneCall).not.toMatch(/x-access-token|ghs_|@github\.com/);
    expect(box.calls[0].opts?.envs).toBeUndefined();
  });

  it("fails loudly when the checked-out sha is not the one we were told about", async () => {
    // A force-push landed between the webhook and the clone: building the wrong
    // tree and reporting it against the old sha would be a silent lie.
    const box = fakeSandbox({
      stdout: { "rev-parse HEAD": `${"b".repeat(40)}\n` },
    });
    await expect(
      cloneAndCheckout(box.sandbox, {
        repoFullName: "mcpjam/mcp-check-fixture",
        prNumber: 7,
        headSha: "a".repeat(40),
      })
    ).rejects.toMatchObject({ outcome: "infra_error" });
  });

  it("treats a failed clone of a public repo as our problem, not the PR’s", async () => {
    const box = fakeSandbox({ exitCodes: { "git clone": 128 } });
    const error = await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/mcp-check-fixture",
      prNumber: 7,
      headSha: "a".repeat(40),
    }).catch((e) => e as CheckStepError);
    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("quotes the sha and repo so neither can inject shell", async () => {
    const box = fakeSandbox({
      stdout: { "rev-parse HEAD": "deadbeef\n" },
    });
    await cloneAndCheckout(box.sandbox, {
      repoFullName: "owner/repo; rm -rf /",
      prNumber: 1,
      headSha: "deadbeef",
    }).catch(() => {});
    // The whole script is a single quoted argument to `bash -lc`, and the
    // injected text stays inside nested quotes.
    expect(box.calls[0].command.startsWith("bash -lc '")).toBe(true);
    expect(box.calls[0].command).not.toMatch(/;\s*rm -rf \/\s*'?\s*&&/);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // PRIVATE REPOSITORIES
  // ═════════════════════════════════════════════════════════════════════════
  //
  // The credential is a short-lived `contents: read` installation token, and
  // every test below is about one of two things: that it reaches git at all,
  // and that it reaches NOTHING ELSE. The second is the interesting half —
  // a token that leaks into a check's output is readable by anyone who can see
  // the pull request.

  /** Computed INDEPENDENTLY of the module, so the test is not a mirror of it. */
  const basicValue = (token: string) =>
    Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");

  /** The three shapes a credential can escape in. */
  const credentialForms = (token: string) => [
    token,
    basicValue(token),
    `AUTHORIZATION: basic ${basicValue(token)}`,
  ];

  const TOKEN = "ghs_privateRepoToken1234567890";

  it("carries the credential on the clone AND the fetch, in a header, never in the URL", async () => {
    const headSha = "c".repeat(40);
    const box = fakeSandbox({ stdout: { "rev-parse HEAD": `${headSha}\n` } });

    await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/private-fixture",
      prNumber: 7,
      headSha,
      cloneToken: TOKEN,
    });

    const script = scriptOf(box.calls[0].command);
    const header = `http.extraheader=AUTHORIZATION: basic ${basicValue(TOKEN)}`;
    // BOTH authenticated requests: the PR ref is a second fetch against the same
    // private repository, and a clone that works followed by a fetch that 404s
    // is the shape of forgetting it.
    expect(script).toContain(`git -c '${header}' clone --depth 50`);
    expect(script).toContain(`git -c '${header}' fetch --depth 50 origin`);
    // The URL stays the ORDINARY public-looking HTTPS one. A credential in the
    // URL is written verbatim into `.git/config`, where the PR's own build runs.
    expect(script).toContain("'https://github.com/mcpjam/private-fixture.git'");
    expect(script).not.toContain("x-access-token:");
    expect(script).not.toMatch(/https:\/\/[^'\s]*@github\.com/);
    // The RAW token never appears anywhere in the command stream — only the
    // base64 of `x-access-token:<token>` does.
    expect(script).not.toContain(TOKEN);
    // Not an env var, not a file, not a credential helper.
    expect(box.calls[0].opts?.envs).toBeUndefined();
    expect(script).not.toContain("credential.helper");
    expect(script).not.toContain("git config");
  });

  it("keeps the credential off the checkout and everything after it", async () => {
    // `-c` is process-scoped, so it is gone the moment git exits. What must not
    // happen is it being added to commands that do not need it: a detached
    // checkout is purely local, and `rev-parse` reads the clone we already have.
    const headSha = "c".repeat(40);
    const box = fakeSandbox({ stdout: { "rev-parse HEAD": `${headSha}\n` } });

    await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/private-fixture",
      prNumber: 7,
      headSha,
      cloneToken: TOKEN,
    });

    const script = scriptOf(box.calls[0].command);
    const [checkoutSegment] = script.split("git checkout").slice(1);
    expect(checkoutSegment).toBeDefined();
    expect(checkoutSegment).not.toContain("extraheader");
    // The sha assertion is its own command, and carries nothing.
    const revParse = box.calls[1].command;
    expect(revParse).toContain("rev-parse HEAD");
    expect(revParse).not.toContain("extraheader");
    for (const form of credentialForms(TOKEN)) {
      expect(revParse).not.toContain(form);
    }
    // Exactly two `-c` occurrences in the whole script: the clone and the fetch.
    expect(script.match(/-c 'http\.extraheader=/g)).toHaveLength(2);
  });

  it("leaves the anonymous clone byte-for-byte unchanged", async () => {
    // The public path is the overwhelming majority of checks, and it must not
    // acquire so much as a stray space from the private one existing.
    const headSha = "a".repeat(40);
    const box = fakeSandbox({ stdout: { "rev-parse HEAD": `${headSha}\n` } });

    await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/mcp-check-fixture",
      prNumber: 7,
      headSha,
    });

    expect(scriptOf(box.calls[0].command)).toBe(
      [
        "set -e",
        "rm -rf /home/user/repo",
        "git clone --depth 50 'https://github.com/mcpjam/mcp-check-fixture.git' /home/user/repo",
        "cd /home/user/repo",
        "git fetch --depth 50 origin 'pull/7/head'",
        `git checkout --detach '${headSha}'`,
      ].join(" && ")
    );
  });

  it("redacts every credential form out of a failing clone's output", async () => {
    // git prints the failing request on some errors, and the output travels to
    // the check's details on somebody's pull request.
    const box = fakeSandbox({
      exitCodes: { "clone --depth 50": 128 },
      stderr: {
        "clone --depth 50": [
          `fatal: unable to access 'https://github.com/mcpjam/private-fixture.git/'`,
          `> AUTHORIZATION: basic ${basicValue(TOKEN)}`,
          `token was ${TOKEN}`,
        ].join("\n"),
      },
    });

    const error = (await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/private-fixture",
      prNumber: 7,
      headSha: "c".repeat(40),
      cloneToken: TOKEN,
    }).catch((e) => e)) as CheckStepError;

    expect(error.outcome).toBe("infra_error");
    const observable = `${error.message}\n${error.detailsMarkdown ?? ""}`;
    for (const form of credentialForms(TOKEN)) {
      expect(observable).not.toContain(form);
    }
    // Redacted, not merely truncated: the surrounding diagnostic survives, so
    // the author still learns the clone failed and against which repository.
    expect(error.detailsMarkdown).toContain("fatal: unable to access");
    expect(error.detailsMarkdown).toContain("[redacted]");
  });

  it("redacts a thrown transport error that echoes the whole command", async () => {
    // THE IMPORTANT ONE. `runForeground`'s transport branch folds
    // `errorMessage(error)` into a `CheckStepError`, and the E2B SDK's errors
    // quote the command they were running — which, for a private clone, is the
    // command carrying the auth header. Nothing about that is redacted by
    // clamping, and this path does not even go through the clamp.
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("clone --depth 50")
          ? new Error(`sandbox unavailable while running: ${command}`)
          : undefined,
    });

    const error = (await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/private-fixture",
      prNumber: 7,
      headSha: "c".repeat(40),
      cloneToken: TOKEN,
    }).catch((e) => e)) as CheckStepError;

    expect(error).toBeInstanceOf(CheckStepError);
    // Ours, not the PR's — E2B being unreachable says nothing about the code.
    expect(error.outcome).toBe("infra_error");
    const observable = `${error.message}\n${error.detailsMarkdown ?? ""}\n${
      error.stack ?? ""
    }`;
    for (const form of credentialForms(TOKEN)) {
      expect(observable).not.toContain(form);
    }
    expect(error.message).toContain("sandbox command failed");
  });

  it("redacts a clone that overran its own deadline", async () => {
    // The deadline branch clamps, and clamping is a LENGTH boundary: a clamped
    // header is still a header. Redaction has to happen first.
    vi.useFakeTimers();
    try {
      const box = fakeSandbox({
        throwOn: (command) => {
          if (!command.includes("clone --depth 50")) return undefined;
          vi.setSystemTime(Date.now() + 6 * 60_000);
          return Object.assign(new Error("timeout"), {
            stderr: `giving up on AUTHORIZATION: basic ${basicValue(TOKEN)}`,
          });
        },
      });

      const error = (await cloneAndCheckout(box.sandbox, {
        repoFullName: "mcpjam/private-fixture",
        prNumber: 7,
        headSha: "c".repeat(40),
        cloneToken: TOKEN,
      }).catch((e) => e)) as CheckStepError;

      const observable = `${error.message}\n${error.detailsMarkdown ?? ""}`;
      for (const form of credentialForms(TOKEN)) {
        expect(observable).not.toContain(form);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("redactCloneCredential", () => {
  const TOKEN = "ghs_aB3.+/=xyz";
  const basic = Buffer.from(`x-access-token:${TOKEN}`, "utf8").toString(
    "base64"
  );

  it("removes the raw token, the base64, and the header", async () => {
    const text = [
      `raw ${TOKEN} here`,
      `encoded ${basic} here`,
      `git -c 'http.extraheader=AUTHORIZATION: basic ${basic}' clone --depth 50`,
    ].join("\n");

    const out = redactCloneCredential(text, TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(basic);
    expect(out).toContain("[redacted]");
    // The shell quoting around the header survives, so the surrounding command
    // is still readable as a command.
    expect(out).toContain("' clone --depth 50");
  });

  it("removes an AUTHORIZATION header even with no token to compare against", async () => {
    // The defence that does not depend on us having guessed the encoding: any
    // basic header goes, token or not. That is what covers a future command
    // that grows one before anybody remembers to thread the secret through.
    const out = redactCloneCredential(
      "> AUTHORIZATION: Basic c29tZXRoaW5nRWxzZQ==",
      undefined
    );
    expect(out).not.toContain("c29tZXRoaW5nRWxzZQ==");
    expect(out).toContain("[redacted]");
  });

  it("is a literal replacement, so regex metacharacters in a token still match", async () => {
    // `.` and `+` in a token would widen or break a pattern built by
    // interpolation. This token has both.
    expect(redactCloneCredential(`prefix ${TOKEN} suffix`, TOKEN)).toBe(
      "prefix [redacted] suffix"
    );
    // And a token-shaped string that is NOT the token is left alone.
    expect(redactCloneCredential("ghs_aB3X+/=xyz", TOKEN)).toBe(
      "ghs_aB3X+/=xyz"
    );
  });

  it("is idempotent, so a doubly-redacted string stays readable", async () => {
    const once = redactCloneCredential(`AUTHORIZATION: basic ${basic}`, TOKEN);
    expect(redactCloneCredential(once, TOKEN)).toBe(once);
  });
});

describe("waitForMcpInitialize", () => {
  const seams = {
    intervalMs: 1,
    sleep: async () => {},
  };

  it("accepts a JSON initialize result", async () => {
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts an SSE-framed initialize result (streamable HTTP servers send either)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(SSE_INITIALIZE_FRAME, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts an initialize result on a stream the server never closes", async () => {
    // THE realistic shape: a streamable-HTTP server answers `initialize` on an
    // SSE stream and then holds it open for server-initiated messages. Reading
    // the body with `response.text()` waits for the stream to END, so it never
    // resolves — every attempt aborts and a perfectly healthy server reads as
    // `server_unhealthy`.
    let cancelled = false;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(SSE_INITIALIZE_FRAME)
              );
              // …and then nothing. No close(): the stream stays open, exactly
              // like a real session.
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5_000,
      })
    ).toBe(true);
    // One attempt, and the socket is released rather than leaked.
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it("decides from a frame that arrives split across chunks", async () => {
    const payload = SSE_INITIALIZE_FRAME.replace("event: message\n", "");
    const cut = 40;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              // A partial frame is not a verdict: it just fails to parse and the
              // read continues.
              controller.enqueue(encoder.encode(payload.slice(0, cut)));
              controller.enqueue(encoder.encode(payload.slice(cut)));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5_000,
      })
    ).toBe(true);
  });

  it("gives up on a stream that never carries an initialize result", async () => {
    // Untrusted code streaming its own logs at us. Bounded by the deadline, not
    // by how long it is willing to talk.
    const fetchImpl = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (init?.signal?.aborted) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode("noise\n"));
            },
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        fetchImpl,
        timeoutMs: 60,
        intervalMs: 10,
      })
    ).toBe(false);
  });

  it("keeps polling through connection refusals and succeeds once the server boots", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < 3) throw new Error("ECONNREFUSED");
      return okInitialize();
    }) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 10_000,
      })
    ).toBe(true);
    expect(call).toBe(3);
  });

  it("sends a real JSON-RPC initialize, not a bare GET", async () => {
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;
    await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ method: "initialize" });
    expect(init.headers.accept).toContain("text/event-stream");
  });

  it("does not accept an HTTP 200 that isn’t an initialize result", async () => {
    // A framework serving its own index page before the MCP route is mounted.
    const fetchImpl = vi.fn(
      async () => new Response("<html>ok</html>", { status: 200 })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an unsupported protocol version as healthy", async () => {
    // Present is not the same as usable: the real client rejects a version it
    // does not support, which would surface as `infra_error` (neutral) from the
    // eval run instead of the `server_unhealthy` the PR earned.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "bogus-9999" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a modern-only server through server/discover", async () => {
    // A 2026-07-28 endpoint (the official handler with `legacy: "reject"`) has no
    // `initialize` at all. The eval run negotiates eras automatically, so this is
    // a server it can drive — calling it `server_unhealthy` would put a red X on
    // a good PR. Probing alternates eras, so the discover attempt follows the
    // rejected legacy one.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { method: string };
      seen.push(parsed.method);
      if (parsed.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "legacy era rejected" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
    expect(seen).toEqual(["initialize", "server/discover"]);
  });

  it("does not accept a discover result offering no version we speak", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { method: string };
      if (parsed.method === "initialize") {
        return new Response("{}", {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { supportedVersions: ["3099-01-01"], capabilities: {} },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("offers the same legacy version the eval client offers", async () => {
    // `_legacyHandshake` sends `legacyVersions[0]`, and an unpinned connection
    // leaves that list to the SDK's built-in `SUPPORTED_PROTOCOL_VERSIONS`, whose
    // first entry is the latest legacy revision. Proposing an older one would probe
    // a handshake the eval never performs: a server whose `2025-06-18` path works
    // while its latest path is broken would pass here and fail the eval, arriving as
    // a neutral `infra_error` instead of the PR's `server_unhealthy`.
    const offered: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as {
        method: string;
        params?: { protocolVersion?: unknown };
      };
      if (parsed.method === "initialize") {
        offered.push(parsed.params?.protocolVersion);
      }
      return okInitialize();
    }) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
    expect(offered).toEqual(["2025-11-25"]);
  });

  it("does not accept an initialize result naming the modern protocol version", async () => {
    // The legacy handshake accepts only `legacyProtocolVersions(...)` — everything
    // before 2026-07-28 — and throws otherwise, and the eval run's unpinned
    // connection uses the SDK's built-in list. So a server answering `initialize`
    // with a modern revision is one the client refuses; accepting it here would let
    // that server's failure reach us as a neutral `infra_error`. The modern revision
    // is legitimate on the discover arm, which is tested separately.
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { method: string };
      if (parsed.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { ...INITIALIZE_RESULT, protocolVersion: "2026-07-28" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // No modern era either, so the verdict rests on the initialize answer.
      return new Response("{}", {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts an initialize result naming the newest legacy version", async () => {
    // The boundary just below the modern era must still be accepted: it is in the
    // SDK's built-in list, so the client speaks it.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { ...INITIALIZE_RESULT, protocolVersion: "2025-11-25" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a discover result whose nested capability flags are mistyped", async () => {
    // `ServerCapabilitiesSchema` types `tools.listChanged` as a boolean, and the
    // client runs that schema over the discover result. `{ listChanged: "yes" }` is
    // an object at the top level and a violation one level down, so the client
    // classifies this result `legacy` and declines the modern era — which is the
    // only thing this arm is asked about.
    const fetchImpl = discoverCapabilitiesFetch({
      tools: { listChanged: "yes" },
    });
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a discover result whose extensions are not a map of objects", async () => {
    // `extensions` is a record of name → object, so a bare `true` fails the schema,
    // as does a member that is not an object.
    for (const extensions of [true, { "com.example/thing": "on" }]) {
      expect(
        await waitForMcpInitialize("https://box/mcp", {
          ...seams,
          fetchImpl: discoverCapabilitiesFetch({ extensions }),
          timeoutMs: 5,
        })
      ).toBe(false);
    }
  });

  it("accepts a discover result advertising tasks in any shape", async () => {
    // `ServerCapabilities2026Schema` — the schema the rev2026 codec validates a
    // discover result with — defines seven members and `tasks` is not one of them.
    // So `tasks` is an unknown member, stripped rather than rejected, and the client
    // negotiates the modern era regardless of its shape. Validating it against the
    // 2025 schema's `tasks` shape turned working servers into `server_unhealthy`.
    for (const tasks of [true, { list: true }, "on"]) {
      expect(
        await waitForMcpInitialize("https://box/mcp", {
          ...seams,
          fetchImpl: discoverCapabilitiesFetch({ tools: {}, tasks }),
        })
      ).toBe(true);
    }
  });

  it("accepts a discover result whose nested capabilities are all well typed", async () => {
    // The other direction, and the one that would hurt: every typed member here is
    // the type the schema asks for, and the unknown extension member is an object,
    // so the client drives this server in the modern era. Rejecting it would be a
    // false `server_unhealthy` on a working PR.
    const fetchImpl = discoverCapabilitiesFetch(
      {
        tools: { listChanged: true },
        prompts: {},
        resources: { subscribe: true, listChanged: false },
        logging: {},
        experimental: { "com.example/lab": {} },
        extensions: { "com.example/thing": { enabled: true } },
        tasks: { list: {}, requests: { tools: { call: {} } } },
      },
      "how to drive me"
    );
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a discover result whose instructions are not a string", async () => {
    const fetchImpl = discoverCapabilitiesFetch({ tools: {} }, 42);
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an answer whose event type carries trailing whitespace", async () => {
    // The parser strips ONE optional space after the colon and keeps the rest, so
    // this event's type is `"message "` — which is not `"message"`, so the transport
    // drops it. Trimming the value here would normalise it and accept an answer the
    // eval run never receives.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: message \ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a data field written with no space after the colon", async () => {
    // `data:{...}` is legal and the space is optional, so the single-space rule must
    // not eat the payload's first character.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `data:${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a result whose _meta is not an object", async () => {
    // `ResultSchema` types `_meta` as an optional OBJECT, so `_meta: true` fails the
    // envelope parse before any handshake logic runs — the client never looks at the
    // rest of the result, however valid it is.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { ...INITIALIZE_RESULT, _meta: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a result carrying a well-formed _meta", async () => {
    // The other direction: `_meta` is loose, so any object passes — including the
    // server-info key the spec suggests putting there.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              ...INITIALIZE_RESULT,
              _meta: { "io.modelcontextprotocol/serverInfo": { name: "x" } },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept an envelope mixing result with error", async () => {
    // The result-response arm is `{ jsonrpc, id, result }` and it is strict, so an
    // envelope carrying `error` as well matches no arm of the union and the
    // transport throws on it. The result inside is irrelevant — the client never
    // gets to look at it.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
            error: { code: -32603, message: "also broken" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an envelope carrying an extra top-level key", async () => {
    // Same rule, less obvious case: `.strict()` rejects any unknown key, not just a
    // conflicting discriminator.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
            method: "initialize",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts an answer delivered in a JSON batch", async () => {
    // Under `application/json` the transport unwraps an array and dispatches each
    // element, so a batched answer is one the eval run receives. Rejecting it would
    // be a false `server_unhealthy` on a server the client drives fine.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    // Bounded: this must be accepted on the first attempt, so a regression fails in
    // a second instead of spinning out the full health window.
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 1_000,
      })
    ).toBe(true);
  });

  it("does not accept a JSON batch whose sibling is not a message", async () => {
    // The transport maps the whole array through its message schema, so one
    // malformed element throws and takes our answer with it. The batch is unusable.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
            { not: "a jsonrpc message" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a batch whose sibling matches no message arm", async () => {
    // `{"jsonrpc":"2.0"}` is not a request, a notification, a result or an error, so
    // the transport's schema throws on it and the whole batch — our answer with it —
    // is discarded. `jsonrpc: "2.0"` alone is not enough to call a sibling valid.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
            { jsonrpc: "2.0" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a batch whose sibling has an invalid request id", async () => {
    // `null` is not a `RequestIdSchema` value, and the notification arm is strict
    // with no `id` at all — so this sibling matches neither arm, the transport's
    // `.map` throws, and the batch (our answer with it) is discarded.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
            { jsonrpc: "2.0", method: "ping", id: null },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a batch whose error sibling has an invalid id", async () => {
    // The error arm's `id` is optional, but a PRESENT one still has to be an id.
    // Same class as the request case, on the arm the finding did not name.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
            { jsonrpc: "2.0", id: null, error: { code: -1, message: "x" } },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a batch whose sibling has non-object params", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
            { jsonrpc: "2.0", method: "ping", params: "nope" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a batch alongside a well-formed request sibling", async () => {
    // The other direction: a server-initiated request with a real id and object
    // params is a legal arm, so the batch parses and our answer is delivered.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 7, method: "roots/list", params: {} },
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 1_000,
      })
    ).toBe(true);
  });

  it("accepts a batch alongside a notification and an error response", async () => {
    // The other direction: these siblings are all legal arms of the union — a
    // notification with no id, and an error response — so the batch parses and our
    // answer is delivered. Rejecting them would be a false `server_unhealthy`.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", method: "notifications/message" },
            { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "nope" } },
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 1_000,
      })
    ).toBe(true);
  });

  it("does not accept a batch inside an SSE event", async () => {
    // Batching is a JSON-body affordance. The transport's SSE path parses one
    // message per event, so an array in `data:` fails its schema and is dropped —
    // the client's `initialize` goes unanswered.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
          ])}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a correct result acknowledged with 202", async () => {
    // 202 is an acknowledgement: the transport drains the body, discards it, and
    // returns before any result processing. So this answer never reaches the
    // client's `initialize`, and calling the server healthy would hand its failure
    // to us as a neutral `infra_error`.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          { status: 202, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a result served with a 2xx other than 200", async () => {
    // Only 202 is special-cased by the transport; every other 2xx is processed by
    // content type. Narrowing to 200 would be stricter than the client, which is
    // how a working PR earns a false `server_unhealthy`.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a correct result served with the wrong content type", async () => {
    // The eval run's transport rejects anything that is not `application/json`
    // or `text/event-stream` before it parses the body at all. A server that
    // answers perfectly as `text/plain` therefore cannot be driven, and calling
    // it healthy here hands its failure to us as a neutral `infra_error` instead
    // of the `server_unhealthy` the PR earned.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          { status: 200, headers: { "content-type": "text/plain" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts an SSE frame separated by bare CRs, after a BOM", async () => {
    // LF, CRLF and bare CR are all legal separators and a leading BOM is stripped
    // — the transport's parser accepts all of it, so a server it can drive must
    // not read as unhealthy here.
    const frame = `﻿event: message\rdata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    })}\r\r`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(frame, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a capability the client's schema types as an object", async () => {
    // `tools: true` fails the client's capabilities schema, so the eval run cannot
    // drive this server — that is the PR's fault, not ours.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { ...INITIALIZE_RESULT, capabilities: { tools: true } },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an SSE-framed result declared as application/json", async () => {
    // The transport switches on the declared type, and for `application/json` it
    // calls `response.json()` — which throws on `event: …\ndata: …` framing. So
    // this server cannot be driven, however well-formed the JSON inside the frame
    // is, and reading the frame anyway would call it healthy on the strength of
    // something the client never gets to see.
    const fetchImpl = vi.fn(
      async () =>
        new Response(SSE_INITIALIZE_FRAME, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a bare JSON result declared as text/event-stream", async () => {
    // The mirror case: under `text/event-stream` the transport runs its
    // EventSource parser, and a body with no `data:` line carries no events — the
    // client's `initialize` would go unanswered until it timed out.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a JSON body that continues past its first document", async () => {
    // `response.json()` rejects trailing content, so a second document (or junk)
    // after the first makes the whole body unparseable for the client. Deciding as
    // soon as a valid prefix landed would pass a server the eval run cannot use.
    const answer = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(`${answer}\n${answer}\n`, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a JSON body that arrives in several chunks", async () => {
    // The flip side of withholding a JSON decision until the body ends: a body
    // split across writes must still be accepted once the last one lands.
    const answer = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    });
    const split = Math.floor(answer.length / 2);
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(answer.slice(0, split)));
            controller.enqueue(encoder.encode(answer.slice(split)));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts a media type that carries parameters", async () => {
    // `application/json; charset=utf-8` is the same essence, and the transport
    // compares essences — so this must not be turned away.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts an unknown capability of any shape", async () => {
    // The client's schema passes unknown keys through, so an extension advertised
    // as a bare string is still a server the eval run can drive. Rejecting it
    // would be stricter than the client — a false server_unhealthy.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              ...INITIALIZE_RESULT,
              capabilities: { tools: {}, "com.example/thing": "on" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a discover result offering only legacy versions", async () => {
    // `server/discover` is the MODERN arm. A result naming only 2025-era
    // revisions says nothing about it: for such a server the client falls back to
    // `initialize`, and whether THAT works is what the legacy probe answers. So an
    // endpoint that answers discover with legacy-only versions while rejecting
    // `initialize` is not a server the eval run can drive, and must not read as
    // healthy off the arm that never proved it.
    let clock = 0;
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { method: string };
      seen.push(parsed.method);
      if (parsed.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "legacy era rejected" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            supportedVersions: ["2025-06-18", "2025-11-25"],
            capabilities: {},
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        fetchImpl,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => clock,
        sleep: async () => {
          clock += 10;
        },
      })
    ).toBe(false);
    // The modern arm really did run — this is a rejection, not a probe that never
    // got its turn.
    expect(seen).toContain("server/discover");
  });

  it("joins an event's data fields before parsing them", async () => {
    // SSE concatenates consecutive `data:` fields within one event. A server that
    // spreads one JSON-RPC message across several is legal; parsing each line
    // alone made every fragment fail and reported a false server_unhealthy.
    // Fields are joined with a newline, per spec — which is exactly what a
    // pretty-printed payload needs, since a newline is JSON whitespace between
    // tokens. (A server splitting mid-token would be sending malformed SSE.)
    const pretty = JSON.stringify(
      { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
      null,
      2
    );
    const frame = pretty
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n");
    const fetchImpl = vi.fn(
      async () =>
        new Response(`event: message\n${frame}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept an answer carried by a named non-message event", async () => {
    // The transport dispatches an event's data only when the event is unnamed or
    // named `message` — `event: ping` is dropped before its data is ever parsed.
    // So the eval run's `initialize` would go unanswered here, and reading the
    // payload anyway would call this server healthy off bytes the client discards.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: ping\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a real answer that follows a named non-message event", async () => {
    // The name belongs to its own event and must not leak into the next one: a
    // server that emits `event: ping` before answering is perfectly usable, so the
    // filter must not turn the answer behind it into a false `server_unhealthy`.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: ping\ndata: {"noise":true}\n\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not decide on a multi-field event before its terminator arrives", async () => {
    // The first `data:` field parses on its own, but the event is not over: the
    // second field makes the joined payload something else entirely. Deciding at
    // the chunk boundary would accept an answer the server never finished sending.
    // Held instead until the blank line, at which point the whole event is judged
    // — and this one is not valid JSON, so the verdict is "not healthy".
    const chunks = [
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: INITIALIZE_RESULT,
      })}\n`,
      `data: "and the rest of the message"\n\n`,
    ];
    let clock = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        fetchImpl,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => clock,
        sleep: async () => {
          clock += 10;
        },
      })
    ).toBe(false);
  });

  it("does not accept a final event the server left unterminated", async () => {
    // Closing the body does NOT terminate the event. `EventSourceParserStream` is a
    // `TransformStream` with no `flush`, so a pending event with no blank line after
    // it is dropped on close rather than delivered — the client's `initialize` never
    // gets an answer. Parsing the tail here anyway would call such a server healthy
    // off a message the eval run never receives.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  SSE_INITIALIZE_FRAME.replace(/\n+$/, "\n")
                )
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts an answer whose event name a colonless event line cleared", async () => {
    // A line with no colon is that field with an empty value, and `event` with an
    // empty value CLEARS the type — so this event is unnamed and the transport
    // dispatches it as `message`. Skipping the colonless line would keep `ping` and
    // discard an answer the client does receive: a false `server_unhealthy`.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: ping\nevent\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts an answer whose event carries id, retry and comment lines", async () => {
    // None of these fields carry data and none of them end the event, so the
    // payload must survive them intact. An unknown field is reported to an
    // `onError` the transport never passes, so it is ignored too.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          [
            ": keep-alive comment",
            "id: 7",
            "retry: 1000",
            "x-unknown: whatever",
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: INITIALIZE_RESULT,
            })}`,
            "",
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts a JSON body that measures exactly the byte cap", async () => {
    // The boundary is a working server: the whole document arrived, and the body
    // ended there. Only the read after the cap can prove it ended, since `done`
    // never rides along with the last chunk — and refusing to take that read would
    // put a false `server_unhealthy` on a PR whose answer merely happens to be
    // 64 KiB long.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(cappedDocument()));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;

    // Bounded deliberately: this must be accepted on the first attempt, so if it
    // ever regresses the test fails in a second rather than spinning out the full
    // two-minute health window.
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 1_000,
      })
    ).toBe(true);
  });

  it("does not accept a cap-sized JSON body that keeps going in a later write", async () => {
    // Same first chunk as above, so the cap is reached with nothing dropped — but
    // the body has not ended, and the read that follows says so. This is the case
    // the extra read has to get right: `response.json()` would reject the trailing
    // content.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(cappedDocument()));
              controller.enqueue(encoder.encode('{"trailing":"junk"}'));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a capped JSON body that parses as a prefix", async () => {
    // A body whose first `PROBE_MAX_RESPONSE_BYTES` happen to be a complete JSON
    // document, followed by more content. We stop reading at the cap; the client
    // does not — `response.json()` reads to EOF and rejects the trailing bytes. So
    // the cap must not stand in for the body ending, or the probe passes a server
    // the eval run cannot parse.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${cappedDocument()}{"trailing":"junk"}`
                )
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a serverInfo without a name and version", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an initialize result missing required fields", async () => {
    // `InitializeResultSchema` requires `capabilities` and `serverInfo`. A
    // result carrying only a good `protocolVersion` passes this probe but fails
    // the client's own validation moments later — the same false neutral.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an answer to a different request as healthy", async () => {
    // Someone else's response, or a server echoing a wrong id, is not proof our
    // handshake completed — the client correlates by id and so does this.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            result: INITIALIZE_RESULT,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a JSON-RPC error response as healthy", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "nope" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("bounds each attempt so a server that accepts and never answers cannot hang the check", async () => {
    // Untrusted PR code that takes the socket and goes silent. Without a
    // per-attempt bound this await never returns and the check occupies the
    // worker's only in-flight slot until the sandbox TTL.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    ) as unknown as typeof fetch;

    const started = Date.now();
    const result = await waitForMcpInitialize("https://box/mcp", {
      fetchImpl,
      timeoutMs: 150,
      intervalMs: 10,
    });
    expect(result).toBe(false);
    // Bounded by the health deadline, not by the server's patience.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].signal
    ).toBeDefined();
  });

  it('does not misread a JSON body that merely contains "data:" as an SSE frame', async () => {
    // A serverInfo name, instructions blob, or tool description can contain
    // "data:" — classifying the whole body as SSE yielded zero payloads and a
    // false server_unhealthy.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "reads data: urls", version: "1" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("gives up at the deadline", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    let clock = 0;
    const result = await waitForMcpInitialize("https://box/mcp", {
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 25,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result).toBe(false);
    // Bounded: it stops once another interval would overshoot the deadline.
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeLessThanOrEqual(5);
  });
});

describe("clampOutput", () => {
  it("fences with a longer run so a log containing a fence cannot break out", () => {
    const clamped = clampOutput("before\n```\n# heading\n```\nafter");
    expect(clamped.startsWith("````text\n")).toBe(true);
    expect(clamped.endsWith("\n````")).toBe(true);
  });

  it("strips ANSI escapes and NULs, keeps tabs and newlines", () => {
    const clamped = clampOutput("a\u001b[31mred\u001b[0m\u0000\tb\nc");
    expect(clamped).toContain("\tb");
    expect(clamped).not.toContain("\u001b");
    expect(clamped).not.toContain("\u0000");
  });

  it("keeps the tail and says so", () => {
    const clamped = clampOutput(`${"x".repeat(OUTPUT_CLAMP_CHARS + 100)}TAIL`);
    expect(clamped).toContain("TAIL");
    expect(clamped).toContain("Showing the last");
  });

  it("returns empty rather than an empty code block", () => {
    expect(clampOutput("")).toBe("");
    expect(clampOutput(undefined)).toBe("");
    expect(clampOutput("  \n ")).toBe("");
  });
});

describe("recipes", () => {
  // The LOOKUP is tested against a synthetic table, so it stays covered no
  // matter what the production override table contains (today: nothing).
  const TABLE = {
    "synthetic/override-repo": {
      build: "make override-build",
      start: "./override-start",
      port: 4321,
      mcpPath: "/override-mcp",
    },
  };

  it("looks up case-insensitively, and trims", () => {
    expect(lookupRecipe(TABLE, "  Synthetic/Override-Repo ")).toMatchObject({
      port: 4321,
      mcpPath: "/override-mcp",
    });
  });

  it("returns null for anything else — the worker maps that to recipe_unresolvable", () => {
    expect(lookupRecipe(TABLE, "someone/unknown-server")).toBeNull();
    expect(lookupRecipe(TABLE, "")).toBeNull();
    expect(resolveCheckRecipe("someone/unknown-server")).toBeNull();
    expect(resolveCheckRecipe("")).toBeNull();
  });

  it("the production override table is EMPTY, and must stay that way", () => {
    // GUARD, not an incidental assertion. The override rung outranks a repo's
    // own mcpjam.yaml, so every entry added here MASKS that repository's
    // declared config for as long as it is present — which is exactly how the
    // old mcpjam/mcp-check-fixture entry made the resolver ladder untestable
    // (delete its yaml, break its yaml, or exercise detection: same override
    // recipe, same green check).
    //
    // Updating this test is a deliberate act. Read the docblock in ../recipes
    // first, and remove the entry as soon as whatever it unblocks is fixed.
    expect(listRecipeRepos()).toEqual([]);
    expect(resolveCheckRecipe("mcpjam/mcp-check-fixture")).toBeNull();
  });
});

describe("buildAndStart — the recipe's declared environment", () => {
  // WHERE THE ENVIRONMENT GOES, AND WHERE IT MUST NOT.
  //
  // It goes into E2B's `envs` COMMAND OPTION on exactly two commands: the build
  // and the start. It never becomes shell text. An `export FOO=…` prepended to
  // a command string would put author-controlled bytes inside a script that is
  // already carrying a `bash -lc` quoting boundary, and every diagnostic this
  // module produces quotes commands — so a value in a command string is a value
  // in a check summary, a log line, and an SDK transport error.
  //
  // Everything else the box runs — clone, fetch, sha verification, `/proc`
  // inspection, the log tail — is OUR plumbing, not the PR's server, and gets
  // nothing.
  const ENV = { LOG_LEVEL: "debug", FIXTURE_MODE: "strict" };
  const ENV_RECIPE = { ...RECIPE, env: ENV };

  const isBuild = (call: Call) => call.command.includes("npm run build");
  const isStart = (call: Call) => Boolean(call.opts?.background);

  it("passes the SAME map to the build and the start, in `envs`", async () => {
    const box = fakeSandbox();
    await buildAndStart(box.sandbox, ENV_RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });

    const build = box.calls.find(isBuild);
    const start = box.calls.find(isStart);
    expect(build?.opts?.envs).toEqual(ENV);
    expect(start?.opts?.envs).toEqual(ENV);
  });

  it("keeps every value OUT of the command strings", async () => {
    // Values chosen to be visible if they were ever interpolated, and to break
    // the script if they were interpolated unquoted.
    const hostile = {
      LOG_LEVEL: "SENTINEL-$(touch /tmp/pwned)",
      QUOTED: `it's "quoted"; rm -rf /`,
    };
    const box = fakeSandbox();
    await buildAndStart(
      box.sandbox,
      { ...RECIPE, env: hostile },
      {
        fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      }
    );

    for (const call of box.calls) {
      expect(call.command).not.toContain("SENTINEL");
      expect(call.command).not.toContain("pwned");
      expect(call.command).not.toContain("LOG_LEVEL");
      expect(call.command).not.toContain("export ");
    }
  });

  it("leaves the build and start command strings byte-identical to the no-env run", async () => {
    // The no-env path is the overwhelming majority of checks. The environment
    // channel must be invisible to it — and to the commands themselves even when
    // an environment IS present, since the whole point is that it travels beside
    // the command rather than inside it.
    const fetchImpl = () =>
      vi.fn(async () => okInitialize()) as unknown as typeof fetch;
    const plain = fakeSandbox();
    await buildAndStart(plain.sandbox, RECIPE, { fetchImpl: fetchImpl() });
    const withEnv = fakeSandbox();
    await buildAndStart(withEnv.sandbox, ENV_RECIPE, {
      fetchImpl: fetchImpl(),
    });

    expect(withEnv.calls.map((call) => call.command)).toEqual(
      plain.calls.map((call) => call.command)
    );
  });

  it("omits `envs` ENTIRELY when the recipe has none", async () => {
    // Not `envs: undefined` and not `envs: {}` — the key is absent, so the
    // options object is the one this module has always sent.
    const box = fakeSandbox();
    await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });

    for (const call of box.calls) {
      expect(Object.keys(call.opts ?? {})).not.toContain("envs");
    }
    expect(box.calls.find(isBuild)?.opts).toEqual({
      cwd: "/home/user/repo",
      timeoutMs: 10 * 60_000,
    });
  });

  it("omits `envs` for an empty map, which is the same as no map", async () => {
    const box = fakeSandbox();
    await buildAndStart(
      box.sandbox,
      { ...RECIPE, env: {} },
      {
        fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      }
    );

    for (const call of box.calls) {
      expect(Object.keys(call.opts ?? {})).not.toContain("envs");
    }
  });

  it("gives the environment to NOTHING except the build and the start", async () => {
    // The `/proc` read for the spawn's process group, and the log tail fetched
    // for a health failure, both run through this module. Neither is the PR's
    // server, and handing them the recipe's environment would put it into
    // commands whose output is quoted into a check summary.
    const box = fakeSandbox({
      // Force the unhealthy path so the log tail is fetched too.
      stdout: { "tail -c": "server said nothing useful" },
    });
    await buildAndStart(box.sandbox, ENV_RECIPE, {
      fetchImpl: vi.fn(
        async () => new Response("nope", { status: 500 })
      ) as unknown as typeof fetch,
      healthTimeoutMs: 1,
      healthIntervalMs: 1,
    }).catch(() => {});

    const others = box.calls.filter((call) => !isBuild(call) && !isStart(call));
    // The `/proc` read and the log tail, at least — if this ever drops to zero
    // the assertion below has stopped testing anything.
    expect(others.length).toBeGreaterThan(0);
    for (const call of others) {
      expect(call.opts?.envs).toBeUndefined();
    }
  });

  it("gives the clone NOTHING, with or without a credential", async () => {
    // `cloneAndCheckout` runs before any recipe is executed and takes no recipe
    // at all — asserted here so a future signature change that threads one in
    // has to come past this test. The clone credential goes the other way: it
    // rides a command-line `-c` header and is never an environment variable.
    const headSha = "d".repeat(40);
    for (const cloneToken of [undefined, "ghs_privateRepoToken1234567890"]) {
      const box = fakeSandbox({ stdout: { "rev-parse HEAD": `${headSha}\n` } });
      await cloneAndCheckout(box.sandbox, {
        repoFullName: "mcpjam/private-fixture",
        prNumber: 7,
        headSha,
        cloneToken,
      });
      for (const call of box.calls) {
        expect(call.opts?.envs).toBeUndefined();
      }
    }
  });

  it("still attributes a failing build to the PR when an environment is present", async () => {
    // The environment must not change what a failure MEANS: a non-zero build is
    // still the pull request's, with its log tail attached.
    const box = fakeSandbox({
      exitCodes: { "npm run build": 1 },
      stdout: { "tail -c": "boom" },
    });

    const error = await buildAndStart(box.sandbox, ENV_RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    }).catch((e) => e as CheckStepError);

    expect((error as CheckStepError).outcome).toBe("build_failed");
    expect((error as CheckStepError).detailsMarkdown).toContain("boom");
  });
});
