import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  obtainStdioCommandApproval,
  readStdioCommandApprovalTerms,
  useStdioCommandApprovalStore,
} from "../stdio-command-approval";
import { STDIO_COMMAND_APPROVAL_REQUIRED_REASON } from "@/shared/stdio-command-approval";

const TERMS = {
  serverId: "srv-1",
  fingerprint: "ab".repeat(32),
  command: "node",
  args: ["server.js"],
  envNames: ["FOO"],
  previouslyApproved: false,
};

const REFUSAL = {
  success: false,
  error: "needs approval",
  reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
  serverId: "srv-1",
  approval: TERMS,
};

const PROMPT = { projectId: "proj-1", serverName: "Files", terms: TERMS };

/**
 * Answers the next prompt, whether it is already queued or opens later, and
 * resolves with the terms it showed.
 */
function answerNextPrompt(allowed: boolean) {
  return new Promise<typeof TERMS>((resolve) => {
    const answer = (
      state: ReturnType<typeof useStdioCommandApprovalStore.getState>,
    ) => {
      const head = state.queue[0];
      if (!head) return false;
      state.settle(allowed);
      resolve(head.terms);
      return true;
    };
    if (answer(useStdioCommandApprovalStore.getState())) return;
    const unsubscribe = useStdioCommandApprovalStore.subscribe((state) => {
      if (answer(state)) unsubscribe();
    });
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readStdioCommandApprovalTerms", () => {
  it("reads the terms off a refusal", () => {
    expect(readStdioCommandApprovalTerms(REFUSAL)).toEqual(TERMS);
  });

  it.each([
    null,
    "nope",
    {},
    { success: true },
    { reason: "other", approval: TERMS },
    { reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON },
    {
      reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
      approval: { ...TERMS, command: 1 },
    },
    {
      reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
      approval: { ...TERMS, args: "server.js" },
    },
  ])("ignores %j", (value) => {
    expect(readStdioCommandApprovalTerms(value)).toBeNull();
  });
});

describe("obtainStdioCommandApproval", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    useStdioCommandApprovalStore.setState({ queue: [] });
  });

  it("returns false without calling the server when the user declines", async () => {
    const outcome = obtainStdioCommandApproval(PROMPT);
    await answerNextPrompt(false);
    expect(await outcome).toBe(false);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("records the approval the user allowed", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ success: true, fingerprint: TERMS.fingerprint }),
    );

    const outcome = obtainStdioCommandApproval(PROMPT);
    await answerNextPrompt(true);
    expect(await outcome).toBe(true);

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/mcp/servers/approve-command");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "proj-1",
      serverId: "srv-1",
      serverName: "Files",
      fingerprint: TERMS.fingerprint,
    });
  });

  it("shows the new command when it changed before the approval landed", async () => {
    const moved = { ...TERMS, args: ["evil.js"], fingerprint: "cd".repeat(32) };
    authFetchMock
      .mockResolvedValueOnce(jsonResponse({ ...REFUSAL, approval: moved }, 409))
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const outcome = obtainStdioCommandApproval(PROMPT);
    expect(await answerNextPrompt(true)).toEqual(TERMS);
    expect(await answerNextPrompt(true)).toEqual(moved);
    expect(await outcome).toBe(true);

    const second = authFetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(second[1].body)).fingerprint).toBe(
      moved.fingerprint,
    );
  });

  it("surfaces an approval that fails for another reason", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "disk full" }, 500),
    );

    const outcome = obtainStdioCommandApproval(PROMPT);
    await answerNextPrompt(true);
    await expect(outcome).rejects.toThrow("disk full");
  });

  it("queues prompts so one dialog shows at a time", async () => {
    const store = useStdioCommandApprovalStore.getState();
    const first = store.request(PROMPT);
    const second = store.request({ ...PROMPT, serverName: "Other" });

    const names = () =>
      useStdioCommandApprovalStore.getState().queue.map((p) => p.serverName);
    expect(names()).toEqual(["Files", "Other"]);

    useStdioCommandApprovalStore.getState().settle(true);
    expect(await first).toBe(true);
    expect(names()).toEqual(["Other"]);

    useStdioCommandApprovalStore.getState().settle(false);
    expect(await second).toBe(false);
    expect(names()).toEqual([]);
  });
});
