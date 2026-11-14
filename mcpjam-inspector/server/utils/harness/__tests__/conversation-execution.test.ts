import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversationExecutionArgs,
  startBoundConversationExecutionCheck,
} from "../conversation-execution.js";
import { takeEarly } from "../../early-start.js";

const scope = {
  projectId: "project-1",
  chatSessionId: "chat-1",
  scenarioId: undefined,
  executionBindingVersion: 1 as const,
  harness: "claude-code" as const,
};

describe("conversationExecutionArgs", () => {
  it("asks for the binding the turn persists under", () => {
    const signal = new AbortController().signal;
    expect(
      conversationExecutionArgs({ scope, authHeader: "Bearer t", signal }),
    ).toEqual({
      mcpClientManager: undefined,
      projectId: "project-1",
      chatSessionId: "chat-1",
      origin: "playground",
      executionBindingVersion: 1,
      scenarioId: undefined,
      executionScope: undefined,
      harness: "claude-code",
      agentLoop: undefined,
      authHeader: "Bearer t",
      signal,
    });
    expect(
      conversationExecutionArgs({ scope: { ...scope, scenarioId: "s-1" } })
        .origin,
    ).toBe("scenario");
  });
});

describe("startBoundConversationExecutionCheck", () => {
  const fetchBinding = vi.fn(
    async (_url: URL | string, _init?: RequestInit) =>
      new Response("{}", { status: 200 }),
  );
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
    vi.stubGlobal("fetch", fetchBinding);
    fetchBinding.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const args = conversationExecutionArgs({ scope, authHeader: "Bearer t" });

  it("leaves an unbound conversation's check to its serial place", () => {
    expect(startBoundConversationExecutionCheck(false, args)).toBeUndefined();
    expect(fetchBinding).not.toHaveBeenCalled();
  });

  it("keeps a scenario turn's check serial even when the direct row is bound", () => {
    const scenarioArgs = conversationExecutionArgs({
      scope: { ...scope, scenarioId: "scenario-1" },
      authHeader: "Bearer t",
    });
    expect(
      startBoundConversationExecutionCheck(true, scenarioArgs),
    ).toBeUndefined();
    expect(fetchBinding).not.toHaveBeenCalled();
  });

  it("starts a bound conversation's check at once", async () => {
    const started = startBoundConversationExecutionCheck(true, args);
    expect(started).toBeDefined();
    await takeEarly(started!);
    expect(fetchBinding).toHaveBeenCalledTimes(1);
    const [url, init] = fetchBinding.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://convex.example.com/web/chat/execution-binding",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      projectId: "project-1",
      chatSessionId: "chat-1",
      origin: "playground",
    });
  });

  it("hands a refused binding back where the turn takes it", async () => {
    fetchBinding.mockResolvedValueOnce(new Response("{}", { status: 409 }));
    const started = startBoundConversationExecutionCheck(true, args);
    await expect(takeEarly(started!)).rejects.toThrow(
      "This conversation cannot continue with the selected runtime. Start a new chat.",
    );
  });
});
