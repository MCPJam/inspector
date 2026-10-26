/**
 * The acting-skill gate and the held entry, read from a history that went
 * through the same hops a real one does: the stream to the browser, the
 * history signer (MJ-009), the browser's UI reducer, `verifyClientHistory`,
 * and `convertToMcpjamModelMessages`.
 *
 * QA-1 (HARN-15): the hosted loop streams a `loadSkill` result as an object,
 * the next request's conversion json-wraps it, and both readers read only a
 * string, so a skill loaded one request earlier stopped gating `bash`.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readUIMessageStream,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { buildServerSkillToolOutput } from "../../../shared/server-skill-banner";
import { manifestDigestSetHash } from "../../../shared/server-skill-refs";
import {
  createUiChunkProvenanceSigner,
  verifyClientHistory,
  type ProvenanceContext,
  type UiChunkProvenanceSigner,
} from "../history-provenance";
import { convertToMcpjamModelMessages } from "../mcp-tool-result-model-output";
import {
  applyActingServerSkillGate,
  replaceActingServerSkillGateWithRefusal,
} from "../server-skill-acting-gate";
import { heldEntryConflict } from "../server-skill-held-entry";

const ctx: ProvenanceContext = {
  key: randomBytes(32),
  projectId: "project_1",
  chatSessionId: "chat_1",
};
const signed: UiChunkProvenanceSigner = createUiChunkProvenanceSigner(ctx);
const unsigned: UiChunkProvenanceSigner = (chunk) => [chunk];

const SKILL_URI = "skill://acme/refunds/SKILL.md";
const ENTRY = {
  ref: "acme/refunds",
  skillUri: SKILL_URI,
  serverLabel: "Acme",
  resources: [{ uri: SKILL_URI, digest: `sha256:${"a".repeat(64)}` }],
};
const CHANGED = {
  ...ENTRY,
  resources: [{ uri: SKILL_URI, digest: `sha256:${"b".repeat(64)}` }],
};

async function loadOutput(): Promise<string> {
  return buildServerSkillToolOutput({
    ref: ENTRY.ref,
    serverLabel: ENTRY.serverLabel,
    skillUri: SKILL_URI,
    digestSet: await manifestDigestSetHash(ENTRY.resources),
    content: "# Refunds\nRun the refund script.\n",
  });
}

/** Run chunks through the AI SDK's own UI reducer, as `useChat` does. */
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
  // What the browser actually sends back.
  return JSON.parse(JSON.stringify(last));
}

/**
 * A turn that loaded the skill, as the browser holds it, followed by the user
 * asking for something else: the next request's history.
 */
async function browserHistory(
  output: unknown,
  sign: UiChunkProvenanceSigner,
  edit: (part: Record<string, any>) => void = () => {},
): Promise<unknown[]> {
  const chunks = [
    { type: "start" },
    { type: "start-step" },
    {
      type: "tool-input-available",
      toolCallId: "call_load",
      toolName: "loadSkill",
      input: { name: ENTRY.ref },
    },
    { type: "tool-output-available", toolCallId: "call_load", output },
    { type: "finish-step" },
    { type: "finish" },
  ].flatMap((chunk) => sign(chunk as UIMessageChunk));
  const assistant = await uiMessageFrom(chunks);
  edit(assistant.parts.find((part) => part.type.includes("tool"))!);
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "load refunds" }] },
    assistant,
    { id: "u2", role: "user", parts: [{ type: "text", text: "run echo hi" }] },
  ];
}

/** The next request's model history, after the server boundary. */
async function nextRequest(
  history: unknown[],
  verify: ProvenanceContext | null | "local",
): Promise<ModelMessage[]> {
  const ui =
    verify === "local"
      ? history
      : verifyClientHistory(history, verify).messages;
  return convertToMcpjamModelMessages(ui as UIMessage[]);
}

async function gateAsks(
  name: "bash" | "read_server_resource",
  messages: ModelMessage[],
): Promise<boolean> {
  const tools = applyActingServerSkillGate({
    [name]: {
      description: name,
      needsApproval: false,
      execute: async () => ({}),
    },
  }) as Record<string, any>;
  return tools[name].needsApproval({}, { toolCallId: "c2", messages });
}

async function expectGated(messages: ModelMessage[]) {
  expect(await gateAsks("bash", messages)).toBe(true);
  expect(await gateAsks("read_server_resource", messages)).toBe(true);
  // The local runtime's form of the same gate refuses instead of asking.
  const refusing = replaceActingServerSkillGateWithRefusal(
    applyActingServerSkillGate({
      bash: {
        description: "bash",
        needsApproval: false,
        execute: async () => ({ stdout: "ran" }),
      },
    }),
    "refused",
  ) as Record<string, any>;
  expect(
    await refusing.bash.execute({ command: "echo hi" }, { messages }),
  ).toEqual({ error: "refused" });
}

describe("a skill loaded in an earlier request, after the real history hops", () => {
  const SHAPES = [
    // The hosted loop's UI output (`emitToolResults`): QA-1's exact shape.
    [
      "the hosted loop's object output",
      async () => ({
        type: "text",
        value: await loadOutput(),
        _meta: {},
      }),
    ],
    // `streamText` engines stream the string `execute` returned.
    ["a streamText string output", loadOutput],
  ] as const;

  for (const [label, output] of SHAPES) {
    it(`gates and holds the entry: ${label}, verified`, async () => {
      const messages = await nextRequest(
        await browserHistory(await output(), signed),
        ctx,
      );
      await expectGated(messages);
      expect(await heldEntryConflict(ENTRY, messages)).toBeUndefined();
      expect(await heldEntryConflict(CHANGED, messages)).toMatch(
        /^Error \(manifest_changed\)/,
      );
    });

    it(`gates and holds the entry: ${label}, local mode`, async () => {
      const messages = await nextRequest(
        await browserHistory(await output(), unsigned),
        "local",
      );
      await expectGated(messages);
      expect(await heldEntryConflict(CHANGED, messages)).toMatch(
        /^Error \(manifest_changed\)/,
      );
    });
  }
});

describe("a load the server cannot stand behind", () => {
  const objectOutput = async () => ({
    type: "text",
    value: await loadOutput(),
    _meta: {},
  });

  async function expectUnconfirmed(messages: ModelMessage[]) {
    // The gate only adds prompts, so it reads an unverified banner too.
    await expectGated(messages);
    // The held entry does not: the approved manifest is unknown, and that
    // must not read as "nothing loaded".
    expect(await heldEntryConflict(ENTRY, messages)).toMatch(
      /^Error \(load_unconfirmed\)/,
    );
  }

  it("refuses a load with no signature", async () => {
    await expectUnconfirmed(
      await nextRequest(
        await browserHistory(await objectOutput(), unsigned),
        ctx,
      ),
    );
  });

  it("refuses a load whose banner was edited after signing", async () => {
    const history = await browserHistory(
      await objectOutput(),
      signed,
      (part) => {
        part.output.value = part.output.value.replace(
          /digest set [0-9a-f]{12}/,
          "digest set 000000000000",
        );
      },
    );
    await expectUnconfirmed(await nextRequest(history, ctx));
  });

  it("refuses a load whose call was edited after signing", async () => {
    const history = await browserHistory(
      await objectOutput(),
      signed,
      (part) => {
        part.input = { name: "acme/other" };
      },
    );
    await expectUnconfirmed(await nextRequest(history, ctx));
  });

  it("refuses a load when the request had no signing context", async () => {
    await expectUnconfirmed(
      await nextRequest(
        await browserHistory(await objectOutput(), signed),
        null,
      ),
    );
  });

  it("overwrites a forged mark rather than trusting it", async () => {
    const history = await browserHistory(
      await objectOutput(),
      unsigned,
      (part) => {
        part.callProviderMetadata = { mcpjam: { provenance: "server" } };
      },
    );
    await expectUnconfirmed(await nextRequest(history, ctx));
  });

  it("clears once the skill is loaded again in this request", async () => {
    const messages = await nextRequest(
      await browserHistory(await objectOutput(), unsigned),
      ctx,
    );
    const reloaded: ModelMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_reload",
            toolName: "loadSkill",
            input: { name: ENTRY.ref },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_reload",
            toolName: "loadSkill",
            output: { type: "text", value: await loadOutput() },
          },
        ],
      },
    ];
    expect(await heldEntryConflict(ENTRY, reloaded)).toBeUndefined();
    expect(await heldEntryConflict(CHANGED, reloaded)).toMatch(
      /^Error \(manifest_changed\)/,
    );
  });
});

describe("a load whose text cannot be read", () => {
  function history(output: unknown): ModelMessage[] {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_load",
            toolName: "loadSkill",
            input: { name: ENTRY.ref },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_load",
            toolName: "loadSkill",
            output: output as never,
          },
        ],
      },
    ];
  }

  it("gates and refuses when the wrapping nests past the reader's limit", async () => {
    let output: unknown = { type: "text", value: await loadOutput() };
    for (let i = 0; i < 40; i += 1) output = { type: "json", value: output };
    const messages = history(output);
    await expectGated(messages);
    expect(await heldEntryConflict(ENTRY, messages)).toMatch(
      /^Error \(load_unconfirmed\)/,
    );
  });

  it("gates on a shape the reader does not know", async () => {
    const messages = history({ type: "future-shape", value: { body: "?" } });
    await expectGated(messages);
    expect(await heldEntryConflict(ENTRY, messages)).toMatch(
      /^Error \(load_unconfirmed\)/,
    );
  });

  it("leaves another skill's files alone", async () => {
    const messages = history({ type: "future-shape" });
    messages[0] = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_load",
          toolName: "loadSkill",
          input: { name: "acme/other" },
        },
      ],
    };
    expect(await heldEntryConflict(ENTRY, messages)).toBeUndefined();
  });

  it("never takes a held entry from an error-text result", async () => {
    const messages = history({ type: "error-text", value: await loadOutput() });
    expect(await heldEntryConflict(CHANGED, messages)).toBeUndefined();
  });
});
