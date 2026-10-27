/**
 * A loaded server skill across reopened conversations: the full persistence
 * cycle, repeated. Each round persists the history as the server does
 * (`signHistoryForPersistence`), hydrates it as the browser does when the
 * conversation is reopened (`transcriptToUIMessages`), verifies it at the
 * server boundary (`verifyClientHistory`) and converts it for the model.
 *
 * Here rather than under `server/` because this config can import the
 * client's transcript conversion.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readUIMessageStream,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { transcriptToUIMessages } from "../../client/src/lib/transcript-to-ui-messages";
import {
  createUiChunkProvenanceSigner,
  signHistoryForPersistence,
  verifyClientHistory,
  type ProvenanceContext,
} from "../../server/utils/history-provenance";
import { convertToMcpjamModelMessages } from "../../server/utils/mcp-tool-result-model-output";
import { applyActingServerSkillGate } from "../../server/utils/server-skill-acting-gate";
import { heldEntryConflict } from "../../server/utils/server-skill-held-entry";
import { buildServerSkillToolOutput } from "../server-skill-banner";
import { manifestDigestSetHash, skillUriHashHex } from "../server-skill-refs";
import { TOOL_OUTPUT_TEXT_DEPTH } from "../tool-output-envelope";

const ctx: ProvenanceContext = {
  key: randomBytes(32),
  projectId: "project_1",
  chatSessionId: "chat_1",
};
const tools = {
  loadSkill: { execute: async () => "" },
  bash: { execute: async () => ({}) },
} as never;

const SKILL_URI = "skill://acme/refunds/SKILL.md";
const ENTRY = {
  ref: "acme/refunds",
  skillUri: SKILL_URI,
  serverId: "srv_acme",
  serverLabel: "Acme",
  resources: [{ uri: SKILL_URI, digest: `sha256:${"a".repeat(64)}` }],
};
const CHANGED = {
  ...ENTRY,
  resources: [{ uri: SKILL_URI, digest: `sha256:${"b".repeat(64)}` }],
};

async function uiMessageFrom(chunks: UIMessageChunk[]): Promise<UIMessage> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  if (!last) throw new Error("no message");
  return JSON.parse(JSON.stringify(last));
}

/** The turn that loaded the skill, streamed by the hosted loop and signed. */
async function liveLoadTurn(): Promise<UIMessage> {
  const sign = createUiChunkProvenanceSigner(ctx);
  const output = buildServerSkillToolOutput({
    ref: ENTRY.ref,
    serverLabel: ENTRY.serverLabel,
    skillUri: SKILL_URI,
    digestSet: await manifestDigestSetHash(ENTRY.resources),
    content: "# Refunds\nRun the refund script.\n",
  });
  return uiMessageFrom(
    [
      { type: "start" },
      { type: "start-step" },
      {
        type: "tool-input-available",
        toolCallId: "call_load",
        toolName: "loadSkill",
        input: { name: ENTRY.ref },
      },
      {
        type: "tool-output-available",
        toolCallId: "call_load",
        output: { type: "text", value: output, _meta: {} },
      },
      { type: "finish-step" },
      { type: "finish" },
    ].flatMap((chunk) => sign(chunk as UIMessageChunk)),
  );
}

function userTurn(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/** One request at the server boundary: verify, then convert. */
async function serve(history: UIMessage[]) {
  const report = verifyClientHistory(history, ctx);
  const messages = await convertToMcpjamModelMessages(
    report.messages as UIMessage[],
  );
  return { report, messages };
}

/** How many `json` envelopes the `loadSkill` result is wrapped in. */
function loadResultDepth(messages: ModelMessage[]): number {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "loadSkill")
        continue;
      let depth = 0;
      let output: unknown = part.output;
      while ((output as { type?: unknown } | undefined)?.type === "json") {
        depth += 1;
        output = (output as { value: unknown }).value;
      }
      return depth;
    }
  }
  throw new Error("no loadSkill result");
}

async function bashAsks(messages: ModelMessage[]): Promise<boolean> {
  const gated = applyActingServerSkillGate({
    bash: {
      description: "bash",
      needsApproval: false,
      execute: async () => ({}),
    },
  }) as Record<string, any>;
  return gated.bash.needsApproval({}, { toolCallId: "c", messages });
}

describe("a loaded server skill across reopened conversations", () => {
  it("still gates after every persist → hydrate → verify → convert, and fails safe past the reader's limit", async () => {
    // Each reopen wraps the persisted result in one more `json` envelope
    // (out of scope here). Until the reader's limit the entry is held; past
    // it the entry is refused as unconfirmed, never read as "nothing loaded".
    const reAddressed = `acme/refunds~${(await skillUriHashHex(SKILL_URI)).slice(0, 8)}`;
    let browser: UIMessage[] = [
      userTurn("u0", "load refunds"),
      await liveLoadTurn(),
      userTurn("u1", "run echo hi"),
    ];
    for (let round = 1; round <= TOOL_OUTPUT_TEXT_DEPTH + 3; round += 1) {
      const { report, messages } = await serve(browser);
      // The signature the server wrote still verifies after the round trip.
      expect(report.unverifiedToolResults, `round ${round}`).toBe(0);
      expect(report.unverifiedToolCalls, `round ${round}`).toBe(0);
      expect(await bashAsks(messages), `round ${round}`).toBe(true);
      const readable = loadResultDepth(messages) <= TOOL_OUTPUT_TEXT_DEPTH;
      // Names and collision suffixes can change while the skill keeps its URI.
      for (const [own, changed] of [
        [ENTRY, CHANGED],
        [
          { ...ENTRY, ref: reAddressed },
          { ...CHANGED, ref: reAddressed },
        ],
        [
          { ...ENTRY, ref: "acme/returns" },
          { ...CHANGED, ref: "acme/returns" },
        ],
      ]) {
        expect(await heldEntryConflict(own, messages)).toEqual(
          readable
            ? undefined
            : expect.stringMatching(/^Error \(load_unconfirmed\)/),
        );
        expect(await heldEntryConflict(changed, messages)).toMatch(
          readable
            ? /^Error \(manifest_changed\)/
            : /^Error \(load_unconfirmed\)/,
        );
      }

      // The server persists this request's history; the user reopens it from
      // the sidebar and sends another message.
      const persisted = signHistoryForPersistence(messages, ctx, tools);
      browser = [
        ...transcriptToUIMessages(JSON.parse(JSON.stringify(persisted))),
        userTurn(`u${round + 1}`, "and again"),
      ];
    }
  });

  it("refuses the held entry, and still gates, once a reopened load stops verifying", async () => {
    const { messages } = await serve([
      userTurn("u0", "load refunds"),
      await liveLoadTurn(),
      userTurn("u1", "run echo hi"),
    ]);
    const persisted = signHistoryForPersistence(messages, ctx, tools);
    const hydrated = transcriptToUIMessages(
      JSON.parse(JSON.stringify(persisted)),
    );
    // A different key: what a reopened conversation looks like to a server
    // that cannot verify it.
    const report = verifyClientHistory([...hydrated, userTurn("u2", "again")], {
      ...ctx,
      key: randomBytes(32),
    });
    expect(report.unverifiedToolResults).toBeGreaterThan(0);
    const next = await convertToMcpjamModelMessages(
      report.messages as UIMessage[],
    );
    expect(await bashAsks(next)).toBe(true);
    expect(await heldEntryConflict(ENTRY, next)).toMatch(
      /^Error \(load_unconfirmed\)/,
    );
  });
});
