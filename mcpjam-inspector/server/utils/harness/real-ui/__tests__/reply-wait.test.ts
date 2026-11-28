/**
 * The reply poll on the hosted browser while a person has it: they took
 * control in the Playground's pane, so every read is refused until they hand
 * it back. The turn waits for them within the reply's deadline instead of
 * failing as a broken driver.
 *
 * Evidence: fixture. A stub page module over the hosted driver, with the
 * command API's refusals canned.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserAgentCommand,
  BrowserAgentResult,
} from "@/shared/browser-agent-contract";
import { WEB_CLIENT_SITES } from "@/shared/web-clients";
import { createMemorySendJournal, driveRealUiTurn } from "../drive-turn";
import { createHostedPageDriver } from "../hosted-driver";
import { RealUiError, type RealUiPageModule } from "../page-module";

const REPLY = '[data-testid="reply"]';

const held = (code: "lease_held" | "lease_parked"): BrowserAgentResult => ({
  status: "refused",
  commandId: "c",
  refusal: { code, message: "a person has taken control of this browser" },
});

const shown = (text: string): BrowserAgentResult => ({
  status: "executed",
  commandId: "c",
  ok: true,
  page: { viewport: { width: 1024, height: 768 }, pageContent: { untrusted: true, text } },
});

/** A module whose only page reads are the reply's, through the driver. */
function replyOnlyModule(): RealUiPageModule {
  return {
    id: "reply-only",
    version: "test",
    sites: WEB_CLIENT_SITES.claude,
    signedIn: async () => ({ email: "runner@example.com" }),
    blocker: async () => undefined,
    ensureConnector: async () => undefined,
    openNewChat: async () => undefined,
    enableConnector: async () => undefined,
    send: async () => ({ conversationUrl: "https://claude.ai/chat/1" }),
    findSent: async () => undefined,
    answerApproval: async () => false,
    replySignals: async (driver) => {
      const text = await driver.readText(REPLY);
      return { finished: text === "done", signals: text === "done" ? ["reply"] : [] };
    },
    readConversation: async (_driver, url) => ({
      conversationId: "1",
      url,
      replyText: "done",
      toolCalls: [],
    }),
  };
}

function turn(send: (command: BrowserAgentCommand) => Promise<BrowserAgentResult>, replyTimeoutMs: number) {
  return driveRealUiTurn({
    module: replyOnlyModule(),
    driver: createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude }),
    connectors: [{ name: "MCPJam", url: "https://mcp.example.com/mcp/c1" }],
    prompt: "say hello",
    journal: createMemorySendJournal(),
    turnKey: "turn-1",
    stepTimeoutMs: 1_000,
    replyTimeoutMs,
  });
}

describe("the reply poll while a person has the hosted browser", () => {
  it("names a person holding the browser apart from a read that failed", async () => {
    for (const code of ["lease_held", "lease_parked"] as const) {
      const driver = createHostedPageDriver(async () => held(code), { sites: WEB_CLIENT_SITES.claude });
      await expect(driver.readText(REPLY)).rejects.toMatchObject({ code: "person_has_browser" });
      await expect(driver.click("#send")).rejects.toMatchObject({ code: "person_has_browser" });
    }
    const executedHeld = createHostedPageDriver(
      async () => ({
        status: "executed",
        commandId: "c",
        ok: false,
        error: { code: "lease_held", message: "a person took the browser mid-read" },
      }),
      { sites: WEB_CLIENT_SITES.claude },
    );
    await expect(executedHeld.readText(REPLY)).rejects.toMatchObject({ code: "person_has_browser" });
  });

  it("waits for the person to hand the browser back, then finishes the turn", async () => {
    const reads: BrowserAgentResult[] = [held("lease_held"), held("lease_parked"), shown("done")];
    const send = vi.fn(async (command: BrowserAgentCommand) =>
      command.op === "observe" && command.rootSelector === REPLY
        ? (reads.shift() ?? shown("done"))
        : shown(""),
    );
    const result = await turn(send, 10_000);
    expect(result.conversation.replyText).toBe("done");
    expect(result.finishedSignals).toEqual(["reply"]);
    expect(send.mock.calls.filter(([command]) => command.op === "observe")).toHaveLength(3);
  });

  it("times out as the reply, saying a person still had the browser", async () => {
    const send = vi.fn(async () => held("lease_held"));
    const failure = await turn(send, 50).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RealUiError);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "reply_timeout",
      step: "reply",
      message: "A person still had the browser when the reply's time ran out. Select Hand back, then run it again.",
    });
  });
});
