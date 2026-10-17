import { vi } from "vitest";

const state = vi.hoisted(() => ({
  saved: null as Record<string, unknown> | null,
  sessionId: "",
  alive: false,
  resumed: 0,
  executions: 0,
  currentApproval: 1,
  maxApprovals: 1,
  harnessId: "claude-code" as "claude-code" | "codex",
  teardown: vi.fn(),
  hold: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@ai-sdk/harness/agent", async (original) => ({
  ...(await original<typeof import("@ai-sdk/harness/agent")>()),
  HarnessAgent: class {
    async createSession(options: { sessionId: string }) {
      state.sessionId = options.sessionId;
      state.create(options);
      return {
        sessionId: options.sessionId,
        suspendTurn: async () => ({
          type: "continue-turn",
          harnessId: state.harnessId,
          specificationVersion: "harness-v1",
          data: {
            bridge: {
              port: 4100,
              token: "claude-generation",
              lastSeenEventId: 3,
            },
          },
        }),
        detach: async () => ({ type: "resume-session", data: {} }),
        destroy: async () => {},
        stop: async () => ({}),
      };
    }
    private result(completedCall?: number) {
      const pending = state.currentApproval;
      return {
        fullStream: (async function* () {
          if (completedCall !== undefined)
            yield {
              type: "tool-result",
              toolCallId: `call-${completedCall}`,
              toolName: "bash",
              result: "Done",
            };
          if (pending <= state.maxApprovals) {
            yield {
              type: "tool-call",
              toolCallId: `call-${pending}`,
              toolName: "bash",
              input: JSON.stringify({ command: `touch example-${pending}` }),
              providerExecuted: true,
            };
            yield {
              type: "tool-approval-request",
              approvalId: `a${pending}`,
              toolCallId: `call-${pending}`,
            };
          } else yield { type: "finish", finishReason: "stop" };
        })(),
        text: Promise.resolve(pending > state.maxApprovals ? "Done" : ""),
      };
    }
    async stream() {
      return this.result();
    }
    async continueStream(options: {
      toolApprovalContinuations: { approved: boolean }[];
    }) {
      state.resumed++;
      const approved = options.toolApprovalContinuations[0]?.approved;
      if (approved) state.executions++;
      const previous = state.currentApproval++;
      return this.result(approved ? previous : undefined);
    }
  },
}));
export { state as localApprovalFixture };
