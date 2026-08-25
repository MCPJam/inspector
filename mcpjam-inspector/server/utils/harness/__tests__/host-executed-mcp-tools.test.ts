/**
 * COMP-39 — host-executed MCP delivery for the Codex harness.
 *
 * Every assertion here fails against the previous behaviour, where Codex had no
 * MCP delivery at all and a Codex host with selected servers was refused before
 * a turn ever opened.
 */
import { describe, expect, it, vi } from "vitest";
import { buildToolPolicySnapshot } from "@mcpjam/sdk/contract";
import { scrubMetaAndStructuredContentFromToolResult } from "@mcpjam/sdk";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  harnessMcpToolName,
  projectSelectedMcpServersAsHostTools,
} from "../host-executed-mcp-tools";
import {
  buildHarnessProxyMcpJson,
  parseHarnessToolName,
} from "../mcp-config";
import { getHarnessAdapter } from "../registry";

type FakeTool = {
  description?: string;
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};

/** A manager stub exposing only what the projection consumes. */
function fakeManager(servers: Record<string, Record<string, FakeTool>>) {
  const getToolsForAiSdk = vi.fn(async (ids: string[]) => {
    const id = ids[0]!;
    // Mirrors the real manager: ONE call per server id, tools keyed by their
    // un-namespaced name.
    return { ...(servers[id] ?? {}) };
  });
  return {
    getServerConfig: vi.fn((id: string) =>
      Object.prototype.hasOwnProperty.call(servers, id) ? { url: "x" } : undefined
    ),
    getToolsForAiSdk,
  } as never as Parameters<
    typeof projectSelectedMcpServersAsHostTools
  >[0]["manager"] & {
    getToolsForAiSdk: typeof getToolsForAiSdk;
  };
}

function tool(result: unknown = { ok: true }): FakeTool {
  return { description: "d", execute: vi.fn(async () => result) };
}

describe("projectSelectedMcpServersAsHostTools", () => {
  it("names projected tools exactly as Claude Code namespaces its MCP tools", async () => {
    const manager = fakeManager({
      "weather-api": { get_forecast: tool() },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["weather-api"],
    });

    // The name the model sees must be byte-identical to the one Claude Code's
    // own MCP client produces from the SAME server id, or a trace/eval
    // assertion written against a Claude Code run stops matching on Codex.
    const claudeKey = Object.keys(
      buildHarnessProxyMcpJson([
        { name: "weather-api", proxyUrl: "https://example.com/mcp" },
      ]).mcpServers
    )[0]!;
    expect(Object.keys(projected.tools)).toEqual([
      `mcp__${claudeKey}__get_forecast`,
    ]);
    // `sanitizeServerName` keeps hyphens, so this id survives unchanged.
    expect(Object.keys(projected.tools)[0]).toBe(
      "mcp__weather-api__get_forecast"
    );
  });

  it("round-trips a relayed call back to the right serverId via parseToolName", async () => {
    const manager = fakeManager({
      "weather-api": { get_forecast: tool() },
      "docs.server": { search: tool() },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["weather-api", "docs.server"],
    });

    // This is what `runHarnessTurn` does with the name the codex bridge relays
    // back — through the ADAPTER, so the Codex adapter's own parseToolName is
    // the thing under test, not just the helper.
    const codex = getHarnessAdapter("codex");
    for (const name of Object.keys(projected.tools)) {
      const attribution = codex.parseToolName(name, projected.keyToServerId);
      expect(attribution.serverId).toBeDefined();
      expect(name).toBe(
        harnessMcpToolName(
          Object.entries(projected.keyToServerId).find(
            ([, serverId]) => serverId === attribution.serverId
          )![0],
          attribution.toolName
        )
      );
    }
    expect(
      codex.parseToolName(
        "mcp__weather-api__get_forecast",
        projected.keyToServerId
      )
    ).toEqual({ serverId: "weather-api", toolName: "get_forecast" });
    expect(
      codex.parseToolName("mcp__docs_server__search", projected.keyToServerId)
    ).toEqual({ serverId: "docs.server", toolName: "search" });
  });

  it("keeps same-named tools from two servers distinct (per-server enumeration)", async () => {
    // The manager's multi-id form flattens last-in-wins, which would silently
    // drop one of these. The projection must call it once per server.
    const manager = fakeManager({
      alpha: { search: tool("alpha") },
      beta: { search: tool("beta") },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["alpha", "beta"],
    });
    expect(Object.keys(projected.tools).sort()).toEqual([
      "mcp__alpha__search",
      "mcp__beta__search",
    ]);
    expect(manager.getToolsForAiSdk).toHaveBeenCalledTimes(2);
    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["alpha"]);
    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["beta"]);
  });

  it("de-duplicates server keys that sanitize to the same name", async () => {
    const manager = fakeManager({
      "a.b": { t: tool() },
      "a-b": { t: tool() },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["a.b", "a-b"],
    });
    expect(Object.keys(projected.tools)).toHaveLength(2);
    expect(new Set(Object.values(projected.keyToServerId))).toEqual(
      new Set(["a.b", "a-b"])
    );
  });

  it("executes through the manager's own tool, not a re-implementation", async () => {
    const inner = tool({ content: [{ type: "text", text: "hi" }] });
    const manager = fakeManager({ srv: { ping: inner } });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["srv"],
    });
    // No policy in force ⇒ the manager's tool object is passed through
    // untouched, so there is exactly one execution path for an MCP call.
    expect(projected.tools["mcp__srv__ping"]).toBe(inner);
  });

  it("skips a selected server with no live config rather than failing the turn", async () => {
    const manager = fakeManager({ live: { t: tool() } });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["live", "stale"],
    });
    expect(Object.keys(projected.tools)).toEqual(["mcp__live__t"]);
    expect(projected.keyToServerId).toEqual({ live: "live" });
  });

  it("returns nothing when no server is selected", async () => {
    const manager = fakeManager({});
    await expect(
      projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: [],
      })
    ).resolves.toEqual({ tools: {}, keyToServerId: {} });
    expect(manager.getToolsForAiSdk).not.toHaveBeenCalled();
  });

  describe("toolPolicy is enforced in-process (the proxy seal has no role here)", () => {
    const snapshot = buildToolPolicySnapshot({
      policy: { mode: "default", deny: ["delete_all"] },
      tools: [{ name: "delete_all" }, { name: "read_thing" }],
    });

    it("blocks a denied tool before it reaches the server", async () => {
      const denied = tool();
      const manager = fakeManager({
        srv: { delete_all: denied, read_thing: tool() },
      });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: { srv: snapshot },
      });
      const gated = projected.tools["mcp__srv__delete_all"] as FakeTool;
      const result = (await gated.execute({}, {})) as {
        content: Array<{ text: string }>;
        _meta: Record<string, { reason: string }>;
      };
      expect(denied.execute).not.toHaveBeenCalled();
      // The SAME envelope the proxy answers with, so the turn's existing
      // detectors account it as blockedByPolicy rather than as a tool failure.
      expect(result.content[0]!.text).toMatch(/^Call blocked by tool policy: /);
      expect(result._meta["mcpjam/policyBlock"]!.reason).toBe("denyList");
    });

    it("lets an allowed tool through untouched", async () => {
      const allowed = tool("real result");
      const manager = fakeManager({ srv: { read_thing: allowed } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: { srv: snapshot },
      });
      const gated = projected.tools["mcp__srv__read_thing"] as FakeTool;
      await expect(gated.execute({ a: 1 }, {})).resolves.toBe("real result");
      expect(allowed.execute).toHaveBeenCalledWith({ a: 1 }, {});
    });

    it("blocks a tool that appeared after launch (unknownAtLaunch)", async () => {
      const late = tool();
      const manager = fakeManager({ srv: { brand_new: late } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: { srv: snapshot },
      });
      const gated = projected.tools["mcp__srv__brand_new"] as FakeTool;
      const result = (await gated.execute({}, {})) as {
        _meta: Record<string, { reason: string }>;
      };
      expect(late.execute).not.toHaveBeenCalled();
      expect(result._meta["mcpjam/policyBlock"]!.reason).toBe("unknownAtLaunch");
    });
  });

  describe("a projection failure fails the turn instead of quietly shrinking it", () => {
    const plugin = {
      pluginId: "p1",
      pluginVersionId: "pv1",
      name: "Calendar Pack",
      bundleHash: "abc",
    };

    it("refuses when a PLUGIN-contributed server has no live connection", async () => {
      // Hosts are plugin-blind: the environment pinned this version precisely to
      // get these tools, so a silently reduced tool set would surface only as
      // the agent "not doing the thing". Name the plugin and refuse.
      const manager = fakeManager({ live: { t: tool() } });
      await expect(
        projectSelectedMcpServersAsHostTools({
          manager,
          selectedServerIds: ["live", "from-plugin"],
          pluginOrigins: { "from-plugin": plugin },
        })
      ).rejects.toThrow(/Calendar Pack/);
    });

    it("propagates an enumeration failure rather than returning a partial set", async () => {
      // Half a tool set is worse than none: the model would silently plan
      // around tools the user believes are attached.
      const manager = fakeManager({ ok: { t: tool() }, broken: {} });
      (manager.getToolsForAiSdk as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ t: tool() }))
        .mockImplementationOnce(async () => {
          throw new Error("server went away mid-enumeration");
        });
      await expect(
        projectSelectedMcpServersAsHostTools({
          manager,
          selectedServerIds: ["ok", "broken"],
        })
      ).rejects.toThrow(/server went away mid-enumeration/);
    });
  });

  /**
   * The relay is a MODEL channel. `execute()` answers the raw MCP result (the
   * inspector's UI renders widgets off it); `toModelOutput()` is the projection
   * the model is allowed to see. The harness host-tool loop only ever calls
   * `execute()`, so without the wrapper an MCP App tool's client-only `_meta`
   * and `structuredContent` rode straight into Codex's context.
   */
  describe("the relay carries the model-facing projection, not the raw result", () => {
    /** An app tool the way `convertMCPToolsToVercelTools` builds one: raw from
     *  `execute`, scrubbed through `toModelOutput`, wrapped in the AI SDK's
     *  `{type:"json"}` transport envelope. */
    function appTool(raw: CallToolResult) {
      return {
        description: "d",
        execute: vi.fn(async () => raw),
        toModelOutput: vi.fn(
          (opts: { toolCallId: string; input: unknown; output: unknown }) => ({
            type: "json" as const,
            value: scrubMetaAndStructuredContentFromToolResult(
              opts.output as CallToolResult
            ),
          })
        ),
      };
    }

    const rawAppResult: CallToolResult = {
      content: [{ type: "text", text: "42 open issues" }],
      structuredContent: { count: 42 },
      _meta: { "openai/outputTemplate": "ui://widget/issues.html" },
    };

    it("scrubs client-only _meta and structuredContent off what the model sees", async () => {
      const inner = appTool(rawAppResult);
      const manager = fakeManager({ gh: { list_issues: inner } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["gh"],
      });
      const relayed = await (
        projected.tools["mcp__gh__list_issues"] as FakeTool
      ).execute({}, { toolCallId: "call-1" });

      // The envelope is unwrapped, so the wire shape is unchanged for a tool
      // with nothing to scrub — but the widget payload is gone.
      expect(relayed).toEqual({
        content: [{ type: "text", text: "42 open issues" }],
      });
      expect(relayed).not.toHaveProperty("_meta");
      expect(relayed).not.toHaveProperty("structuredContent");
      // Not re-implemented here: it is the manager tool's OWN projection, so the
      // harness and the emulated engine cannot disagree about model visibility.
      expect(inner.toModelOutput).toHaveBeenCalledTimes(1);
      expect(inner.toModelOutput.mock.calls[0]![0]!.output).toBe(rawAppResult);
    });

    it("hands the RAW result back for the UI, keyed by toolCallId", async () => {
      // The runtime echoes back only what it was given, so without this the UI,
      // the trace and the transcript would all show the scrubbed copy — a
      // divergence from every other engine.
      const seen: Array<{ toolCallId: string; raw: unknown }> = [];
      const manager = fakeManager({ gh: { list_issues: appTool(rawAppResult) } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["gh"],
        onRawResult: (a) => seen.push(a),
      });
      await (projected.tools["mcp__gh__list_issues"] as FakeTool).execute(
        {},
        { toolCallId: "call-7" }
      );
      expect(seen).toEqual([{ toolCallId: "call-7", raw: rawAppResult }]);
    });

    it("leaves a tool with no projection untouched, by identity", async () => {
      // Most MCP tools are not app tools. They must not pay a wrapper, and the
      // single-execution-path property has to survive this change.
      const inner = tool({ content: [{ type: "text", text: "hi" }] });
      const manager = fakeManager({ srv: { ping: inner } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
      });
      expect(projected.tools["mcp__srv__ping"]).toBe(inner);
      await expect(
        (projected.tools["mcp__srv__ping"] as FakeTool).execute({}, {})
      ).resolves.toEqual({ content: [{ type: "text", text: "hi" }] });
    });

    it("passes a non-json output envelope through as-is", async () => {
      // The image/linked-resource projection is a genuinely different,
      // self-describing shape; flattening it would make the model guess.
      const contentOutput = {
        type: "content" as const,
        value: [{ type: "media", data: "…", mediaType: "image/png" }],
      };
      const inner = {
        description: "d",
        execute: vi.fn(async () => ({ content: [] })),
        toModelOutput: vi.fn(() => contentOutput),
      };
      const manager = fakeManager({ srv: { shot: inner } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
      });
      await expect(
        (projected.tools["mcp__srv__shot"] as FakeTool).execute({}, {})
      ).resolves.toEqual(contentOutput);
    });

    it("does not project a policy block envelope (projection is innermost)", async () => {
      // Above the gate, the projection would scrub the `_meta` marker the turn
      // recognises its OWN block by, and a refusal would be misaccounted as the
      // customer's tool failing.
      const inner = appTool(rawAppResult);
      const manager = fakeManager({ srv: { delete_all: inner } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: {
          srv: buildToolPolicySnapshot({
            policy: { mode: "default", deny: ["delete_all"] },
            tools: [{ name: "delete_all" }],
          }),
        },
      });
      const result = (await (
        projected.tools["mcp__srv__delete_all"] as FakeTool
      ).execute({}, {})) as { _meta: Record<string, { reason: string }> };
      expect(result._meta["mcpjam/policyBlock"]!.reason).toBe("denyList");
      expect(inner.toModelOutput).not.toHaveBeenCalled();
    });

    it("still observes a scope challenge through the projection wrapper", async () => {
      // Layering must not cost the SEP-2350 bridge: the error is raised by the
      // innermost `execute`, below the projection, and still reaches the sink.
      const error = Object.assign(new Error("Forbidden"), {
        name: "InsufficientScopeError",
        requiredScope: "repo.write",
      });
      const inner = {
        description: "d",
        execute: vi.fn(async () => {
          throw error;
        }),
        toModelOutput: vi.fn(() => ({ type: "json" as const, value: {} })),
      };
      const manager = fakeManager({ gh: { create_issue: inner } });
      const seen: unknown[] = [];
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["gh"],
        onScopeStepUpChallenge: (event) => seen.push(event),
      });
      await expect(
        (projected.tools["mcp__gh__create_issue"] as FakeTool).execute(
          {},
          { toolCallId: "call-2" }
        )
      ).rejects.toBe(error);
      expect(seen).toHaveLength(1);
      expect(inner.toModelOutput).not.toHaveBeenCalled();
    });
  });

  describe("scope step-up (SEP-2350) survives in-process execution", () => {
    /** What a live 403 `insufficient_scope` surfaces as, per the SDK's
     *  `isInsufficientScopeNode` (branded class name + challenge fields). */
    function insufficientScope(): Error {
      const error = new Error("Forbidden");
      error.name = "InsufficientScopeError";
      return Object.assign(error, {
        requiredScope: "calendar.write",
        resourceMetadataUrl: new URL(
          "https://cal.example/.well-known/oauth-protected-resource"
        ),
      });
    }

    function throwing(error: Error): FakeTool {
      return {
        description: "d",
        execute: vi.fn(async () => {
          throw error;
        }),
      };
    }

    it("publishes the exact tuple the turn correlates a challenge on", async () => {
      const error = insufficientScope();
      const manager = fakeManager({ cal: { create_event: throwing(error) } });
      const seen: unknown[] = [];
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["cal"],
        onScopeStepUpChallenge: (event) => seen.push(event),
      });

      const t = projected.tools["mcp__cal__create_event"] as FakeTool;
      // The error still reaches the caller — this observes, never swallows.
      await expect(
        t.execute({ title: "x" }, { toolCallId: "call-1" })
      ).rejects.toBe(error);

      // `runHarnessTurn` matches a challenge to its observed tool call on
      // exactly (serverId, UN-namespaced toolName, raw input). Anything else
      // here and the correlation silently never fires.
      expect(seen).toEqual([
        {
          serverId: "cal",
          toolCallId: "call-1",
          requiredScope: "calendar.write",
          resourceMetadataUrl:
            "https://cal.example/.well-known/oauth-protected-resource",
          errorDescription: undefined,
          toolName: "create_event",
          toolInput: { title: "x" },
        },
      ]);
    });

    it("stays quiet on an ordinary tool failure", async () => {
      const manager = fakeManager({
        srv: { t: throwing(new Error("upstream 500")) },
      });
      const seen: unknown[] = [];
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        onScopeStepUpChallenge: (event) => seen.push(event),
      });
      await expect(
        (projected.tools["mcp__srv__t"] as FakeTool).execute({}, {})
      ).rejects.toThrow("upstream 500");
      expect(seen).toEqual([]);
    });

    it("passes the manager's tool through by identity when no sink is given", async () => {
      // Eval/synthetic callers supply no sink and cannot pause anyway; they must
      // not pay a wrapper, so the single-execution-path property still holds.
      const inner = tool();
      const manager = fakeManager({ srv: { ping: inner } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
      });
      expect(projected.tools["mcp__srv__ping"]).toBe(inner);
    });

    it("still observes when a policy snapshot is also in force", async () => {
      const error = insufficientScope();
      const manager = fakeManager({ srv: { read_thing: throwing(error) } });
      const seen: unknown[] = [];
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: {
          srv: buildToolPolicySnapshot({
            policy: { mode: "default", deny: ["delete_all"] },
            tools: [{ name: "delete_all" }, { name: "read_thing" }],
          }),
        },
        onScopeStepUpChallenge: (event) => seen.push(event),
      });
      await expect(
        (projected.tools["mcp__srv__read_thing"] as FakeTool).execute({}, {})
      ).rejects.toBe(error);
      expect(seen).toHaveLength(1);
    });

    it("does not fire for a call the policy blocked (gate is outermost)", async () => {
      // A denied call reaches no server, so there is no challenge to raise —
      // and it returns the block envelope rather than throwing at all.
      const manager = fakeManager({
        srv: { delete_all: throwing(insufficientScope()) },
      });
      const seen: unknown[] = [];
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: {
          srv: buildToolPolicySnapshot({
            policy: { mode: "default", deny: ["delete_all"] },
            tools: [{ name: "delete_all" }],
          }),
        },
        onScopeStepUpChallenge: (event) => seen.push(event),
      });
      const result = (await (
        projected.tools["mcp__srv__delete_all"] as FakeTool
      ).execute({}, {})) as { _meta: Record<string, { reason: string }> };
      expect(result._meta["mcpjam/policyBlock"]!.reason).toBe("denyList");
      expect(seen).toEqual([]);
    });
  });
});

/**
 * The host's tool-CONSTRUCTION options must reach `getToolsForAiSdk`.
 *
 * `getToolsForAiSdk(serverIds?, options = {})` says outright that it will not
 * read a host config itself — "the mode is resolved by the CALLER". This
 * projection called it with NO options object, so every host-derived input was
 * dropped and a Codex turn's MCP tools were built under the SDK's defaults. The
 * previous fix wired `toModelOutput` through; the tool it ran was still built
 * with the wrong policy, so the turn projected under a policy the host never
 * chose.
 *
 * Every assertion in this block fails against that behaviour.
 */
describe("host-derived tool-construction options reach the SDK conversion", () => {
  /**
   * A manager stub that HONORS the options, the way the real one does.
   *
   * The point is that the assertions below read the RELAYED VALUE, not the
   * arguments: `toModelOutput` drops a direct image block unless
   * `directContent.image` is on — the same gate `model-output.ts` applies — and
   * an app-only tool is omitted from the set unless `includeAppOnly` is set,
   * the same gate `tool-converters.ts` applies. A projection that forwards
   * nothing therefore produces observably different tools and observably
   * different model-facing output.
   */
  function policyHonoringManager(
    servers: Record<
      string,
      Record<string, { appOnly?: boolean; result: unknown }>
    >
  ) {
    const getToolsForAiSdk = vi.fn(
      async (
        ids: string[],
        options?: {
          includeAppOnly?: boolean;
          modelVisibleMcpToolResults?: {
            directContent?: { image?: boolean };
          };
          tasks?: unknown;
          needsApproval?: boolean;
        }
      ) => {
        const id = ids[0]!;
        const out: Record<string, unknown> = {};
        for (const [name, spec] of Object.entries(servers[id] ?? {})) {
          if (spec.appOnly && !options?.includeAppOnly) continue;
          out[name] = {
            description: "d",
            // Presence of a task seam is observable on the built tool, exactly
            // as the SDK's seam is (it changes what a call sends).
            ...(options?.tasks !== undefined ? { _tasksSeam: true } : {}),
            ...(options?.needsApproval !== undefined
              ? { needsApproval: options.needsApproval }
              : {}),
            execute: vi.fn(async () => spec.result),
            toModelOutput: ({ output }: { output: unknown }) => {
              const raw = output as { content?: Array<{ type?: string }> };
              const allowImages =
                options?.modelVisibleMcpToolResults?.directContent?.image ===
                true;
              return {
                type: "json" as const,
                value: {
                  content: (raw.content ?? []).filter(
                    (block) => allowImages || block.type !== "image"
                  ),
                },
              };
            },
          };
        }
        return out;
      }
    );
    return {
      getServerConfig: vi.fn((id: string) =>
        Object.prototype.hasOwnProperty.call(servers, id)
          ? { url: "x" }
          : undefined
      ),
      getToolsForAiSdk,
    } as never as Parameters<
      typeof projectSelectedMcpServersAsHostTools
    >[0]["manager"] & { getToolsForAiSdk: typeof getToolsForAiSdk };
  }

  const withImage = {
    content: [
      { type: "text", text: "here is the chart" },
      { type: "image", data: "iVBOR…", mimeType: "image/png" },
    ],
  };

  it("applies the HOST's modelVisibleMcpToolResults to what the relay carries", async () => {
    // THE REPORTED BUG. Without the option the tool is built under the SDK
    // default, so the projection runs — with the wrong policy. The image the
    // host explicitly allowed never reaches the model.
    const manager = policyHonoringManager({
      charts: { render: { result: withImage } },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["charts"],
      toolOptions: {
        modelVisibleMcpToolResults: {
          directContent: { image: true },
        } as never,
      },
    });
    const relayed = await (
      projected.tools["mcp__charts__render"] as FakeTool
    ).execute({}, { toolCallId: "call-1" });
    expect(relayed).toEqual(withImage);
  });

  it("omits the image when the host policy disallows it", async () => {
    // The other direction, so the assertion above cannot pass by accident on a
    // projection that ignores the policy in a permissive way.
    const manager = policyHonoringManager({
      charts: { render: { result: withImage } },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["charts"],
      toolOptions: {
        modelVisibleMcpToolResults: {
          directContent: { image: false },
        } as never,
      },
    });
    const relayed = await (
      projected.tools["mcp__charts__render"] as FakeTool
    ).execute({}, { toolCallId: "call-1" });
    expect(relayed).toEqual({
      content: [{ type: "text", text: "here is the chart" }],
    });
  });

  it("includes SEP-1865 app-only tools when the host opts out of visibility", async () => {
    // `respectToolVisibility === false` (Cursor/VS Code templates today) is a
    // host declaring it does not filter app-only tools. Latent on Codex right
    // now — no harness template sets it — but the same dropped-option class.
    const manager = policyHonoringManager({
      gh: {
        list_issues: { result: { ok: true } },
        render_widget: { appOnly: true, result: { ok: true } },
      },
    });
    const optedOut = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["gh"],
      toolOptions: { includeAppOnly: true },
    });
    expect(Object.keys(optedOut.tools).sort()).toEqual([
      "mcp__gh__list_issues",
      "mcp__gh__render_widget",
    ]);

    // …and the spec default still hides it.
    const filtered = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["gh"],
      toolOptions: { includeAppOnly: false },
    });
    expect(Object.keys(filtered.tools)).toEqual(["mcp__gh__list_issues"]);
  });

  it("carries the resolved task seam into the built tools", async () => {
    // Dropping the seam degrades MCP Tasks to the pre-existing no-`_meta` path
    // on this delivery mode only — a host-level policy silently meaning
    // something different on Codex than on Claude Code.
    const manager = policyHonoringManager({ srv: { t: { result: {} } } });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["srv"],
      toolOptions: { tasks: { mode: "await" } as never },
    });
    expect(projected.tools["mcp__srv__t"]).toMatchObject({
      _tasksSeam: true,
    });
  });

  it("never sets needsApproval — host-executed approval is the agent's own gate", async () => {
    // Deliberately absent, not forgotten: `HarnessAgent`'s `toolApproval` map
    // is what gates a host-executed call, and the AI SDK flag is read by the
    // EMULATED loop, which never runs on this path. A second, inert approval
    // declaration would read like enforcement.
    const manager = policyHonoringManager({ srv: { t: { result: {} } } });
    await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["srv"],
      toolOptions: {
        modelVisibleMcpToolResults: {
          directContent: { image: true },
        } as never,
      },
    });
    const passed = manager.getToolsForAiSdk.mock.calls[0]![1];
    // An options object IS built (the host set a policy) — it just never
    // carries the approval flag.
    expect(passed).toBeDefined();
    expect(passed).not.toHaveProperty("needsApproval");
  });

  it("takes the NO-OPTIONS overload when no host input applies", async () => {
    // The byte-identity property: a default harness turn must produce exactly
    // the tools it produced before any of this existed. Passing `{}` would be
    // behaviorally equal today and would quietly invite a future default in.
    const manager = policyHonoringManager({ srv: { t: { result: {} } } });
    await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["srv"],
      toolOptions: {
        modelVisibleMcpToolResults: undefined,
        includeAppOnly: false,
        tasks: undefined,
      },
    });
    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["srv"]);
    expect(manager.getToolsForAiSdk.mock.calls[0]).toHaveLength(1);
  });

  it("builds ONE options object for the whole projection", async () => {
    // The options are host-level. Two selected servers must not be able to get
    // different ones.
    const manager = policyHonoringManager({
      a: { t: { result: {} } },
      b: { t: { result: {} } },
    });
    await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["a", "b"],
      toolOptions: { includeAppOnly: true },
    });
    expect(manager.getToolsForAiSdk).toHaveBeenCalledTimes(2);
    expect(manager.getToolsForAiSdk.mock.calls[0]![1]).toBe(
      manager.getToolsForAiSdk.mock.calls[1]![1]
    );
  });
});

describe("harnessMcpToolName", () => {
  it("is the same scheme parseHarnessToolName reverses", () => {
    const name = harnessMcpToolName("weather", "get_forecast");
    expect(name).toBe("mcp__weather__get_forecast");
    expect(parseHarnessToolName(name, { weather: "srv-1" })).toEqual({
      serverId: "srv-1",
      toolName: "get_forecast",
    });
  });
});
