import { describe, expect, it, vi } from "vitest";
import type { PlatformApiClient } from "@mcpjam/sdk/platform";
import {
  resolveHostTools,
  narrowHostComputer,
} from "../built-in-tools/registry";
import { WEB_SEARCH_TOOL_NAME } from "../built-in-tools/exa-web-search";
import { BASH_TOOL_NAME } from "../built-in-tools/bash";
import { MCPJAM_TOOL_IDS } from "../built-in-tools/mcpjam";

const ctx = {
  authHeader: "Bearer token-123",
  projectId: "project-1",
  chatSessionId: "session-1",
};

// Tool construction never calls the client; resolution tests only need a
// truthy instance. Execute paths live in mcpjam-built-in-tools.test.ts.
const stubClient = {} as PlatformApiClient;

const computer = { kind: "personal", workdir: "/srv" };

describe("resolveHostTools — builtInToolIds", () => {
  it("resolves web_search to a runnable tool", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
    expect(typeof tools![WEB_SEARCH_TOOL_NAME].execute).toBe("function");
  });

  it("skips unknown ids instead of throwing", () => {
    const tools = resolveHostTools(
      { builtInToolIds: ["not_a_tool", WEB_SEARCH_TOOL_NAME] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("returns undefined for undefined / empty ids", () => {
    expect(resolveHostTools({}, ctx)).toBeUndefined();
    expect(resolveHostTools({ builtInToolIds: [] }, ctx)).toBeUndefined();
  });

  it("returns undefined without auth context (local BYOK paths)", () => {
    expect(
      resolveHostTools(
        { builtInToolIds: [WEB_SEARCH_TOOL_NAME, BASH_TOOL_NAME], computer },
        null
      )
    ).toBeUndefined();
  });

  it("returns undefined when every requested id is unknown", () => {
    expect(
      resolveHostTools({ builtInToolIds: ["not_a_tool"] }, ctx)
    ).toBeUndefined();
  });

  it("does not double-prefix a lowercase bearer scheme", () => {
    // RFC 7235 schemes are case-insensitive; "bearer x" must pass through
    // instead of becoming "Bearer bearer x".
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
      { authHeader: "bearer token-123", projectId: "project-1" }
    );
    expect(tools).toBeDefined();
  });

  it("resolves with a raw (prefixless) bearer — eval call shape", () => {
    // Eval threads `convexAuthToken` without the "Bearer " prefix; the
    // resolver normalizes, so the same call shape works for both.
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
      { authHeader: "raw-token", projectId: "project-1" }
    );
    expect(tools).toBeDefined();
    expect(Object.keys(tools!)).toEqual([WEB_SEARCH_TOOL_NAME]);
  });
});

describe("resolveHostTools — computer-backed bash", () => {
  it("advertises bash when the id is granted AND a computer is attached", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME], computer },
      { ...ctx, requireToolApproval: true }
    );
    expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
    const bash = tools![BASH_TOOL_NAME] as { needsApproval?: boolean };
    expect(typeof tools![BASH_TOOL_NAME].execute).toBe("function");
    // The host's approval policy reaches the tool.
    expect(bash.needsApproval).toBe(true);
  });

  it("skips bash when the host grants the id but attaches no computer", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  // ── Eval snapshots now carry `builtInToolIds` AND an ephemeral `computer`.
  //
  // Both halves are new at once, so the hazard is that `bash` gets registered
  // TWICE for one iteration: once here (the host grants the id and the config
  // carries a computer) and once out of band, where the eval runner injects a
  // sandbox-bound `bash` into `prepared.allTools` after provisioning the box.
  //
  // It cannot happen, and these pin the reason: the personal resolver refuses a
  // non-personal kind outright. The two paths are mutually exclusive by
  // construction rather than by ordering luck.

  it("does NOT advertise bash off an EPHEMERAL computer — the per-run box is not a personal resource", () => {
    // An eval iteration's pinned config carries `{ kind: "ephemeral" }`. If
    // this resolved a personal machine from it, the iteration would get a
    // second `bash` pointed at the ACTING MEMBER's own computer, alongside the
    // sandbox-bound one the runner injects.
    const tools = resolveHostTools(
      {
        builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME],
        computer: { kind: "ephemeral" },
      },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("binds exactly ONE bash when the turn owns a sandbox, even with an ephemeral computer on the config", () => {
    // The binding arrives out of band on `ctx` and is checked before every
    // other gate, so it wins outright — one entry, bound to that box.
    const tools = resolveHostTools(
      {
        builtInToolIds: [BASH_TOOL_NAME],
        computer: { kind: "ephemeral" },
      },
      { ...ctx, sandboxBinding: { sandboxId: "sbx_eval_1" } }
    );
    expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
    expect(typeof tools![BASH_TOOL_NAME].execute).toBe("function");
  });

  it("skips bash for an anonymous guest on the personal-project path (backend rejects the reserve)", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME], computer },
      { ...ctx, isGuest: true }
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("advertises bash to a guest ONLY on a host-funded swarm executionScope", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME], computer },
      {
        ...ctx,
        isGuest: true,
        executionScope: {
          kind: "swarm",
          swarmId: "swarm-1",
          accessVersion: 1,
          projectId: "project-1",
          workspaceId: "ws-1",
        },
      }
    );
    expect(Object.keys(tools ?? {})).toContain(BASH_TOOL_NAME);
  });

  it("skips bash for a guest on a project-scoped executionScope (not host-funded)", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME], computer },
      {
        ...ctx,
        isGuest: true,
        executionScope: { kind: "project", projectId: "project-1" },
      }
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("does NOT advertise bash off the computer alone — the id must be granted", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME], computer },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });
});

describe("resolveHostTools — local engine actor coercion (structural)", () => {
  // The observables: the LOCAL engine forces needsApproval:true whatever the
  // host says, and its description names the user's own machine — so a tool
  // built with approval OFF that still requires approval PROVES local
  // survived, and one that doesn't PROVES the downgrade fired.
  function bashTool(extraCtx: Record<string, unknown>) {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME], computer },
      {
        ...ctx,
        requireToolApproval: false,
        computerEngine: "local",
        ...extraCtx,
      } as never
    );
    return tools?.[BASH_TOOL_NAME] as
      | { needsApproval?: boolean; description?: string }
      | undefined;
  }

  it("honors local for a signed-in member's direct turn", () => {
    const bash = bashTool({});
    expect(bash?.needsApproval).toBe(true);
    expect(bash?.description).toMatch(/user's own machine/);
  });

  it("downgrades local for a scenario session", () => {
    const bash = bashTool({ isScenarioSession: true });
    expect(bash?.needsApproval).toBe(false);
    expect(bash?.description).not.toMatch(/user's own machine/);
  });

  it("downgrades local for a guest on a host-funded swarm scope", () => {
    const bash = bashTool({
      isGuest: true,
      executionScope: {
        kind: "swarm",
        swarmId: "swarm-1",
        accessVersion: 1,
        projectId: "project-1",
        workspaceId: "ws-1",
      },
    });
    // Bash IS advertised on the swarm grant — but never on the local engine.
    expect(bash).toBeDefined();
    expect(bash?.needsApproval).toBe(false);
    expect(bash?.description).not.toMatch(/user's own machine/);
  });

  it("never reaches the personal path at all in a journey session", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME], computer },
      { ...ctx, computerEngine: "local", isJourneySession: true } as never
    );
    expect(tools?.[BASH_TOOL_NAME]).toBeUndefined();
  });
});

describe("resolveHostTools — bash in Journey (swarm) sessions", () => {
  it("suppresses bash and reports a visible reason", () => {
    const suppressed: Array<{ id: string; reason: string }> = [];
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME], computer },
      {
        ...ctx,
        isJourneySession: true,
        onToolSuppressed: (info) => suppressed.push(info),
      }
    );
    // The rest of the host's built-ins are untouched — only bash drops.
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.id).toBe(BASH_TOOL_NAME);
    // The reason has to say WHY, not just "unavailable": whoever opens the run
    // needs to tell this apart from a host-config mistake.
    expect(suppressed[0]!.reason).toMatch(/simulated \(swarm\) sessions/);
  });

  it("suppresses bash even when an executionScope is threaded", () => {
    // `executionScope` cannot isolate a Journey run's bash (a signed-in
    // launcher resolves to project_member), so it must not re-open the gate.
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME], computer },
      {
        ...ctx,
        isJourneySession: true,
        executionScope: { kind: "project", projectId: "project-1" },
      }
    );
    expect(tools).toBeUndefined();
  });

  it("leaves evals and hosted chat unaffected", () => {
    for (const surface of [{}, { isScenarioSession: true }]) {
      const tools = resolveHostTools(
        { builtInToolIds: [BASH_TOOL_NAME], computer },
        { ...ctx, ...surface }
      );
      expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
    }
  });

  it("never constructs the bash tool, so no reserve can be attempted", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME], computer },
      { ...ctx, isJourneySession: true }
    );
    // No tool object at all ⇒ nothing the model can invoke ⇒ the reserve call
    // inside `buildBashTool`'s execute is unreachable for this session.
    expect(tools?.[BASH_TOOL_NAME]).toBeUndefined();
  });
});

describe("resolveHostTools — the trusted ephemeral sandbox binding", () => {
  const binding = { sandboxId: "sbx_ephemeral_1", workdir: "/srv/app" };

  it("lifts the Journey suppression — a bound session gets bash", () => {
    const suppressed: Array<{ id: string; reason: string }> = [];
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME], computer },
      {
        ...ctx,
        isJourneySession: true,
        sandboxBinding: binding,
        onToolSuppressed: (info) => suppressed.push(info),
      }
    );
    expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
    // Nothing was suppressed, so no notice should have been emitted either.
    expect(suppressed).toHaveLength(0);
  });

  it("binds to the sandbox even with NO computer on the config", () => {
    // The ephemeral path does not consult `config.computer` at all. A snapshot
    // whose target carries no computer still gets a shell once a binding
    // exists, because the binding IS the resource.
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME] },
      { ...ctx, isJourneySession: true, sandboxBinding: binding }
    );
    expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
  });

  it("cannot be injected through the wire-sourced config", () => {
    // THE unforgeability property. `sandboxBinding` does not exist on
    // HostToolsConfig, so a hostile runtime-config / run-snapshot payload has
    // no field to smuggle one in through — the value can only arrive on `ctx`,
    // which is constructed in-process.
    const hostilePayload = {
      builtInToolIds: [BASH_TOOL_NAME],
      computer: { kind: "ephemeral", sandboxId: "sbx_attacker" },
      sandboxBinding: { sandboxId: "sbx_attacker" },
    } as never;
    const tools = resolveHostTools(hostilePayload, {
      ...ctx,
      isJourneySession: true,
    });
    // Still suppressed: the payload's extra keys are inert.
    expect(tools?.[BASH_TOOL_NAME]).toBeUndefined();
  });

  it("still rejects a forged `ephemeral` computer on a non-journey surface", () => {
    // `narrowHostComputer` is unchanged and only accepts `personal`, so the
    // union that was NOT built stays impossible to fake.
    const tools = resolveHostTools(
      {
        builtInToolIds: [BASH_TOOL_NAME],
        computer: { kind: "ephemeral", sandboxId: "sbx_attacker" },
      },
      ctx
    );
    expect(tools?.[BASH_TOOL_NAME]).toBeUndefined();
  });

  it("guest and executionScope gates do not apply to the ephemeral path", () => {
    // A binding-holder has already passed the backend's provision
    // authorization (project member + run launcher + a claimed, running
    // attempt); the guest/scope gates below it reason about the personal
    // reserve, which is not happening here.
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME] },
      { ...ctx, isGuest: true, sandboxBinding: binding }
    );
    expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
  });

  it("inherits requireToolApproval like the personal path does", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME] },
      { ...ctx, sandboxBinding: binding, requireToolApproval: true }
    );
    expect(tools![BASH_TOOL_NAME].needsApproval).toBe(true);
  });
});

describe("resolveHostTools — workspace tools (platform operation catalog)", () => {
  it("advertises every workspace id when the platform client is wired", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [...MCPJAM_TOOL_IDS] },
      { ...ctx, mcpjamPlatformClient: stubClient }
    );
    expect(Object.keys(tools ?? {}).sort()).toEqual(
      [...MCPJAM_TOOL_IDS].sort()
    );
    expect(typeof tools!["list_project_servers"].execute).toBe("function");
  });

  it("advertises no workspace id without a platform client", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [...MCPJAM_TOOL_IDS, WEB_SEARCH_TOOL_NAME] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("does not advertise any workspace id to guest actors", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [...MCPJAM_TOOL_IDS, WEB_SEARCH_TOOL_NAME] },
      { ...ctx, isGuest: true, mcpjamPlatformClient: stubClient }
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("does not advertise any workspace id in scenario sessions", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [...MCPJAM_TOOL_IDS, WEB_SEARCH_TOOL_NAME] },
      { ...ctx, isScenarioSession: true, mcpjamPlatformClient: stubClient }
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("requireToolApproval gates connection-opening ops but never list_project_servers", () => {
    const tools = resolveHostTools(
      {
        builtInToolIds: [
          "list_project_servers",
          "call_server_tool",
          "diagnose_server",
        ],
      },
      { ...ctx, mcpjamPlatformClient: stubClient, requireToolApproval: true }
    );
    const approval = (id: string) =>
      (tools![id] as { needsApproval?: boolean }).needsApproval;
    expect(approval("call_server_tool")).toBe(true);
    expect(approval("diagnose_server")).toBe(true);
    expect(approval("list_project_servers")).toBe(false);
  });

  it("live ops do not require approval when the host policy is off", () => {
    const tools = resolveHostTools(
      { builtInToolIds: ["call_server_tool"] },
      { ...ctx, mcpjamPlatformClient: stubClient }
    );
    expect(
      (tools!["call_server_tool"] as { needsApproval?: boolean }).needsApproval
    ).toBe(false);
  });
});

describe("narrowHostComputer", () => {
  it("accepts the resource shape and preserves workdir", () => {
    expect(narrowHostComputer({ kind: "personal", workdir: "/srv" })).toEqual({
      kind: "personal",
      workdir: "/srv",
    });
  });

  it("tolerates and drops the legacy toolset key", () => {
    expect(narrowHostComputer({ kind: "personal", toolset: "bash" })).toEqual({
      kind: "personal",
    });
  });

  it("rejects non-objects and wrong kinds; empty workdir collapses", () => {
    expect(narrowHostComputer(undefined)).toBeNull();
    expect(narrowHostComputer(null)).toBeNull();
    expect(narrowHostComputer("personal")).toBeNull();
    expect(narrowHostComputer({ kind: "shared" })).toBeNull();
    // `personal` remains the ONLY accepted kind. The ephemeral sandbox binding
    // deliberately travels on `ctx`, not here — widening this union would make
    // the binding wire-forgeable, which is why it was not done.
    expect(
      narrowHostComputer({ kind: "ephemeral", sandboxId: "sbx_1" })
    ).toBeNull();
    expect(narrowHostComputer({ kind: "personal", workdir: "   " })).toEqual({
      kind: "personal",
    });
  });
});

/**
 * W3: the `browser` capability. The gates here are what keep a model from
 * driving a real, signed-in browser on a surface that never thought about
 * approval — and what keeps a shell off the same box.
 */
describe("resolveHostTools — browser", () => {
  const browserCtx = {
    ...ctx,
    browserApprovalDelivery: { kind: "attested" as const },
  };

  function withFlag<T>(value: string | undefined, run: () => T): T {
    const previous = process.env.HOSTED_BROWSER_TOOLS_ENABLED;
    if (value === undefined) delete process.env.HOSTED_BROWSER_TOOLS_ENABLED;
    else process.env.HOSTED_BROWSER_TOOLS_ENABLED = value;
    try {
      return run();
    } finally {
      if (previous === undefined) {
        delete process.env.HOSTED_BROWSER_TOOLS_ENABLED;
      } else {
        process.env.HOSTED_BROWSER_TOOLS_ENABLED = previous;
      }
    }
  }

  it("is not advertised while the runtime flag is off", () => {
    withFlag(undefined, () => {
      expect(
        resolveHostTools({ builtInToolIds: ["browser"], computer }, browserCtx),
      ).toBeUndefined();
    });
  });

  it("is not advertised when the BACKEND says it is not exposable (W7)", async () => {
    // Honored even with the env flag on. The likeliest reason for a refusal is
    // an unset desktop credit rate, which would meter every hosted browser
    // hour at the cheaper terminal rate.
    const { resetComputersRuntimeConfigBootstrapForTests, initComputersRuntimeConfigBootstrap } =
      await import("../computers/runtime-config");
    resetComputersRuntimeConfigBootstrapForTests();
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "tok");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              enabled: false,
              hostedBrowser: { exposable: false, reason: "desktop_rate_unset" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await initComputersRuntimeConfigBootstrap();
    try {
      const suppressed: Array<{ id: string; reason: string }> = [];
      withFlag("1", () => {
        expect(
          resolveHostTools(
            { builtInToolIds: ["browser"], computer },
            { ...browserCtx, onToolSuppressed: (i) => suppressed.push(i) },
          ),
        ).toBeUndefined();
      });
      expect(suppressed[0]).toMatchObject({ id: "browser" });
      expect(suppressed[0].reason).toContain("not fully configured");
    } finally {
      resetComputersRuntimeConfigBootstrapForTests();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("is still advertised when the backend has not answered at all", async () => {
    // An older backend says nothing. That is not a refusal — the env flag is
    // already dark by default and is what staging drives the runtime with.
    const { resetComputersRuntimeConfigBootstrapForTests } = await import(
      "../computers/runtime-config"
    );
    resetComputersRuntimeConfigBootstrapForTests();
    withFlag("1", () => {
      expect(
        resolveHostTools({ builtInToolIds: ["browser"], computer }, browserCtx),
      ).toBeDefined();
    });
  });

  it("builds the six verbs when enabled, attested and computer-backed", () => {
    withFlag("1", () => {
      const tools = resolveHostTools(
        { builtInToolIds: ["browser"], computer },
        browserCtx,
      );
      expect(Object.keys(tools ?? {}).sort()).toEqual([
        "browser_act",
        "browser_navigate",
        "browser_observe",
        "browser_tabs",
        "browser_webmcp_invoke",
        "browser_webmcp_tools",
      ]);
    });
  });

  it("hands the caller the approval classification to merge", () => {
    withFlag("1", () => {
      let approvals: { requiredNames: ReadonlySet<string> } | undefined;
      resolveHostTools(
        { builtInToolIds: ["browser"], computer },
        {
          ...browserCtx,
          onBrowserApprovals: (value) => {
            approvals = value;
          },
        },
      );
      expect(approvals?.requiredNames.has("browser_act")).toBe(true);
    });
  });

  it("advertises NOTHING on a surface that did not attest approval delivery", () => {
    // The five prepareChatV2 call sites that thread no approvals are safe
    // BECAUSE of this, without any edit to them.
    withFlag("1", () => {
      const suppressed: Array<{ id: string; reason: string }> = [];
      const tools = resolveHostTools(
        { builtInToolIds: ["browser"], computer },
        { ...ctx, onToolSuppressed: (info) => suppressed.push(info) },
      );
      expect(tools).toBeUndefined();
      expect(suppressed.some((s) => s.id === "browser")).toBe(true);
    });
  });

  it("suppresses browser when bash is attached to the same computer", () => {
    withFlag("1", () => {
      const suppressed: Array<{ id: string; reason: string }> = [];
      const tools = resolveHostTools(
        { builtInToolIds: ["bash", "browser"], computer },
        { ...browserCtx, onToolSuppressed: (info) => suppressed.push(info) },
      );
      // bash is KEPT (behavior-preserving for hosts that already had it) and
      // browser is dropped: one uid, one box — a shell can read the browser's
      // cookies and its daemon token out of the process environment.
      expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
      expect(
        suppressed.find((s) => s.id === "browser")?.reason,
      ).toContain("same computer");
    });
  });

  it("allows the pair when the deployment accepted the trust boundary", () => {
    withFlag("1", () => {
      const tools = resolveHostTools(
        { builtInToolIds: ["bash", "browser"], computer },
        { ...browserCtx, allowComputerToolCoTenancy: true },
      );
      expect(Object.keys(tools ?? {})).toContain(BASH_TOOL_NAME);
      expect(Object.keys(tools ?? {})).toContain("browser_act");
    });
  });

  it("requires a computer, refuses guests, and refuses unbound journey sessions", () => {
    withFlag("1", () => {
      expect(
        resolveHostTools({ builtInToolIds: ["browser"] }, browserCtx),
      ).toBeUndefined();
      expect(
        resolveHostTools(
          { builtInToolIds: ["browser"], computer },
          { ...browserCtx, isGuest: true },
        ),
      ).toBeUndefined();
      expect(
        resolveHostTools(
          { builtInToolIds: ["browser"], computer },
          { ...browserCtx, isJourneySession: true },
        ),
      ).toBeUndefined();
    });
  });
});

/**
 * The engine branch. A local browser is not a hosted resource — it boots no
 * desktop, reserves nothing and costs no credits — so the hosted rollout's
 * gates must not decide whether a user can drive their own Chromium, and the
 * actor coercion must still keep unattended surfaces off it.
 */
describe("resolveHostTools — browser engines", () => {
  const localCtx = {
    ...ctx,
    browserApprovalDelivery: { kind: "attested" as const },
    computerEngine: "local" as const,
  };

  function withHostedFlag<T>(value: string | undefined, run: () => T): T {
    const previous = process.env.HOSTED_BROWSER_TOOLS_ENABLED;
    if (value === undefined) delete process.env.HOSTED_BROWSER_TOOLS_ENABLED;
    else process.env.HOSTED_BROWSER_TOOLS_ENABLED = value;
    try {
      return run();
    } finally {
      if (previous === undefined) {
        delete process.env.HOSTED_BROWSER_TOOLS_ENABLED;
      } else {
        process.env.HOSTED_BROWSER_TOOLS_ENABLED = previous;
      }
    }
  }

  it("advertises a LOCAL browser while the hosted rollout flag is off", () => {
    withHostedFlag(undefined, () => {
      const tools = resolveHostTools(
        { builtInToolIds: ["browser"], computer },
        localCtx,
      );
      expect(Object.keys(tools ?? {}).sort()).toEqual([
        "browser_act",
        "browser_navigate",
        "browser_observe",
        "browser_tabs",
        "browser_webmcp_invoke",
        "browser_webmcp_tools",
      ]);
    });
  });

  it("lets a local browser sit beside bash", () => {
    // On the user's own machine the shell already runs as them, with every
    // credential store on it; the co-tenancy rule is about one hosted box.
    withHostedFlag(undefined, () => {
      const tools = resolveHostTools(
        { builtInToolIds: ["browser", "bash"], computer },
        localCtx,
      );
      expect(Object.keys(tools ?? {})).toContain("browser_navigate");
      expect(Object.keys(tools ?? {})).toContain("bash");
    });
  });

  it("still drops the pair on a hosted box", () => {
    withHostedFlag("1", () => {
      const suppressed: Array<{ id: string; reason: string }> = [];
      const tools = resolveHostTools(
        { builtInToolIds: ["browser", "bash"], computer },
        {
          ...ctx,
          browserApprovalDelivery: { kind: "attested" as const },
          onToolSuppressed: (i) => suppressed.push(i),
        },
      );
      expect(Object.keys(tools ?? {})).not.toContain("browser_navigate");
      expect(suppressed.some((s) => s.id === "browser")).toBe(true);
    });
  });

  for (const [label, actor] of [
    ["a guest", { isGuest: true }],
    ["a scenario session", { isScenarioSession: true }],
    ["a journey session", { isJourneySession: true }],
    ["a host-funded swarm scope", {
      executionScope: {
        kind: "swarm" as const,
        swarmId: "swarm-1",
        accessVersion: 1,
        projectId: "project-1",
        workspaceId: "ws-1",
      },
    }],
  ] as const) {
    it(`never gives ${label} the user's own browser`, () => {
      withHostedFlag(undefined, () => {
        // Coerced off `local` at the chokepoint, and then refused by the
        // hosted gates it lands on — so the answer is "no browser", never
        // "someone else's browser".
        const tools = resolveHostTools(
          { builtInToolIds: ["browser"], computer },
          { ...localCtx, ...actor },
        );
        expect(Object.keys(tools ?? {})).not.toContain("browser_navigate");
      });
    });

    it(`refuses ${label} even when the request explicitly asked for this machine`, () => {
      // With the rollout flag OFF, "no browser" can be true for the wrong
      // reason — the flag, not the coercion. Run it ON, with the turn having
      // explicitly asked for the local engine: the coercion downgrades it, the
      // downgrade cannot be honored, and the answer must be "no browser"
      // rather than a silent fall-through to the hosted one.
      withHostedFlag("1", () => {
        const suppressed: Array<{ id: string; reason: string }> = [];
        const tools = resolveHostTools(
          { builtInToolIds: ["browser"], computer },
          {
            ...localCtx,
            ...actor,
            localComputerRequested: true,
            onToolSuppressed: (i: { id: string; reason: string }) =>
              suppressed.push(i),
          },
        );
        expect(Object.keys(tools ?? {})).not.toContain("browser_navigate");
        expect(suppressed.some((s) => s.id === "browser")).toBe(true);
      });
    });
  }
});

describe("resolveHostTools — browser on a machine that cannot serve it", () => {
  function withHostedBrowserFlag<T>(value: string | undefined, run: () => T): T {
    const previous = process.env.HOSTED_BROWSER_TOOLS_ENABLED;
    if (value === undefined) delete process.env.HOSTED_BROWSER_TOOLS_ENABLED;
    else process.env.HOSTED_BROWSER_TOOLS_ENABLED = value;
    try {
      return run();
    } finally {
      if (previous === undefined) {
        delete process.env.HOSTED_BROWSER_TOOLS_ENABLED;
      } else {
        process.env.HOSTED_BROWSER_TOOLS_ENABLED = previous;
      }
    }
  }

  it("suppresses rather than quietly running the user's browser in the cloud", () => {
    // `resolvePersonalComputerEngine`'s own invariant: an explicit `local`
    // that cannot be honored resolves `unavailable`, NEVER silently cloud.
    // The browser branch used to read every non-`local` answer as "hosted".
    const suppressed: Array<{ id: string; reason: string }> = [];
    withHostedBrowserFlag("1", () => {
      expect(
        resolveHostTools(
          { builtInToolIds: ["browser"], computer },
          {
            ...ctx,
            browserApprovalDelivery: { kind: "attested" as const },
            computerEngine: "unavailable" as const,
            localComputerRequested: true,
            onToolSuppressed: (i: { id: string; reason: string }) =>
              suppressed.push(i),
          },
        ),
      ).toBeUndefined();
    });
    expect(suppressed[0]).toMatchObject({ id: "browser" });
    expect(suppressed[0].reason).toContain("this machine");
  });

  it("still builds the HOSTED browser when no local engine was asked for", () => {
    // The common deployment has no local engine configured at all, which says
    // nothing about whether the hosted browser may be advertised.
    withHostedBrowserFlag("1", () => {
      const tools = resolveHostTools(
        { builtInToolIds: ["browser"], computer },
        {
          ...ctx,
          browserApprovalDelivery: { kind: "attested" as const },
          computerEngine: "unavailable" as const,
        },
      );
      expect(Object.keys(tools ?? {})).toContain("browser_act");
    });
  });
});
