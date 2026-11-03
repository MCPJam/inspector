import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  askStdioCommandApprovalForChatError,
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

  it("reads which env values changed since the last approval", () => {
    const changed = {
      ...TERMS,
      previouslyApproved: true,
      changedEnvNames: ["FOO"],
    };
    expect(
      readStdioCommandApprovalTerms({ ...REFUSAL, approval: changed }),
    ).toEqual(changed);
    expect(
      readStdioCommandApprovalTerms({
        ...REFUSAL,
        approval: { ...TERMS, changedEnvNames: "FOO" },
      }),
    ).toEqual(TERMS);
  });

  it("reads the values shown for variables that load code, dropping any that are not strings", () => {
    const withCodeLoading = {
      ...TERMS,
      codeLoadingEnv: { NODE_OPTIONS: "--require=/tmp/x.js" },
    };
    expect(
      readStdioCommandApprovalTerms({ ...REFUSAL, approval: withCodeLoading }),
    ).toEqual(withCodeLoading);
    expect(
      readStdioCommandApprovalTerms({
        ...REFUSAL,
        approval: {
          ...TERMS,
          codeLoadingEnv: { NODE_OPTIONS: 1, PATH: "/bin" },
        },
      }),
    ).toEqual({ ...TERMS, codeLoadingEnv: { PATH: "/bin" } });
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
    toastMock.error.mockReset();
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

  it("reports an approval that fails for another reason and leaves the server unapproved", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "disk full" }, 500),
    );

    const outcome = obtainStdioCommandApproval(PROMPT);
    await answerNextPrompt(true);
    expect(await outcome).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith("disk full");
  });

  it("falls back to its own message when the answer is not JSON", async () => {
    authFetchMock.mockResolvedValue(
      new Response("<html>Bad gateway</html>", { status: 502 }),
    );

    const outcome = obtainStdioCommandApproval(PROMPT);
    await answerNextPrompt(true);
    expect(await outcome).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith(
      "The command could not be approved on this device. Try approving it again.",
    );
  });

  it("reports an approval request that never reached the server", async () => {
    authFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const outcome = obtainStdioCommandApproval(PROMPT);
    await answerNextPrompt(true);
    expect(await outcome).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith(
      "The command could not be approved on this device. Try approving it again.",
    );
  });

  it("sends one approval when several refusals of the same command wait on one dialog", async () => {
    authFetchMock.mockResolvedValue(jsonResponse({ success: true }));

    const first = obtainStdioCommandApproval(PROMPT);
    const second = obtainStdioCommandApproval(PROMPT);
    await answerNextPrompt(true);

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(useStdioCommandApprovalStore.getState().queue).toEqual([]);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("queues prompts so one dialog shows at a time", async () => {
    const store = useStdioCommandApprovalStore.getState();
    const first = store.request(PROMPT);
    const second = store.request({
      ...PROMPT,
      serverName: "Other",
      terms: { ...TERMS, serverId: "srv-other" },
    });

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

describe("askStdioCommandApprovalForChatError", () => {
  // The `details` of the chat route's refusal, as `handleChatError` parses it.
  const REFUSED_TURN = {
    reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
    serverId: "srv-1",
    serverName: "Files",
    approval: TERMS,
  };

  beforeEach(() => {
    authFetchMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    useStdioCommandApprovalStore.setState({ queue: [] });
  });

  it.each([undefined, null, { reason: "other" }])(
    "leaves any other failure alone (%j)",
    async (details) => {
      await askStdioCommandApprovalForChatError(details, "proj-1");
      expect(useStdioCommandApprovalStore.getState().queue).toEqual([]);
    },
  );

  it("asks for the refused server's command, then says to send again", async () => {
    authFetchMock.mockResolvedValue(jsonResponse({ success: true }));

    const asked = askStdioCommandApprovalForChatError(REFUSED_TURN, "proj-1");
    expect(await answerNextPrompt(true)).toEqual(TERMS);
    expect(useStdioCommandApprovalStore.getState().queue).toEqual([]);
    await asked;

    const [, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      projectId: "proj-1",
      serverId: "srv-1",
      serverName: "Files",
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      "Allowed on this device. Send your message again.",
    );
  });

  it("reports an approval that fails", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "disk full" }, 500),
    );

    const asked = askStdioCommandApprovalForChatError(REFUSED_TURN, "proj-1");
    await answerNextPrompt(true);
    await asked;
    expect(toastMock.error).toHaveBeenCalledWith("disk full");
  });
});
