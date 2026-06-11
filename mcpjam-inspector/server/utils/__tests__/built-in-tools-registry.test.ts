import { describe, expect, it } from "vitest";
import {
  resolveHostTools,
  narrowHostComputer,
} from "../built-in-tools/registry";
import { WEB_SEARCH_TOOL_NAME } from "../built-in-tools/exa-web-search";
import { BASH_TOOL_NAME } from "../built-in-tools/bash";

const ctx = {
  authHeader: "Bearer token-123",
  projectId: "project-1",
  chatSessionId: "session-1",
};

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

  it("advertises bash to guest actors too (cost is contained backend-side)", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME], computer },
      { ...ctx, isGuest: true }
    );
    expect(Object.keys(tools ?? {})).toContain(BASH_TOOL_NAME);
  });

  it("does NOT advertise bash off the computer alone — the id must be granted", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME], computer },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
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
    expect(narrowHostComputer({ kind: "personal", workdir: "   " })).toEqual({
      kind: "personal",
    });
  });
});
