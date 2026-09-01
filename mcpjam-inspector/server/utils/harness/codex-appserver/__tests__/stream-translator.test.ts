/**
 * The translator, replayed against streams RECORDED FROM THE REAL BINARY.
 *
 * The fixtures under `fixtures/` came out of `codex app-server` 0.149.1 driven
 * by a scripted model (`.spike-codex-appserver/probe/record-fixtures.mjs`), so
 * these assertions are about what codex actually sends, not what we imagined it
 * sends. That distinction has bitten this repo before: a hand-written fixture
 * agrees with the code and both can be wrong about the world.
 *
 * Every emitted part is validated against the framework's own
 * `harnessV1StreamPartSchema`, so a part shape that would be rejected inside
 * `HarnessAgent` fails here instead of inside a sandbox.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessV1StreamPartSchema } from "@ai-sdk/harness";
import type { BridgeEvent } from "@ai-sdk/harness/bridge";
import { createStreamTranslator } from "../bridge/stream-translator.js";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";

const FIXTURES = join(__dirname, "fixtures");

type Frame = { id?: unknown; method: string; params?: Record<string, unknown> };

function loadFixture(name: string): Frame[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Frame);
}

/** Is this frame a server REQUEST (id + method) rather than a notification? */
const isServerRequest = (frame: Frame) => frame.id !== undefined;

type Replay = {
  parts: BridgeEvent[];
  warnings: string[];
  errors: unknown[];
  approvals: Array<{ approvalId: string; toolCallId: string }>;
};

/**
 * Replay a fixture the way the bridge does: notifications to the translator,
 * approval requests to the same `ensureToolCall` seam the approval controller
 * uses. Keeping both in ONE replay is what makes the ordering guarantee
 * testable — the approval arrives first in these recordings.
 */
function replay(name: string): Replay {
  const parts: BridgeEvent[] = [];
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const approvals: Replay["approvals"] = [];

  const translator = createStreamTranslator({
    emit: (part) => parts.push(part),
    emitWarning: ({ message }) => warnings.push(message),
    emitError: ({ error }) => errors.push(error),
    relayServerName: RELAY_MCP_SERVER_NAME,
    emitRaw: false,
  });

  let approvalSeq = 0;
  for (const frame of loadFixture(name)) {
    if (isServerRequest(frame)) {
      if (frame.method === "item/commandExecution/requestApproval") {
        const params = frame.params ?? {};
        const toolCallId = translator.ensureToolCall(String(params.itemId), {
          toolName: "bash",
          nativeName: "exec_command",
          input: { command: params.command, cwd: params.cwd },
        });
        const approvalId = `codex-approval-${++approvalSeq}`;
        parts.push({ type: "tool-approval-request", approvalId, toolCallId });
        approvals.push({ approvalId, toolCallId });
      }
      continue;
    }
    translator.handleNotification(frame);
  }
  return { parts, warnings, errors, approvals };
}

const typesOf = (parts: BridgeEvent[]) => parts.map((part) => part.type);
const partsOfType = (parts: BridgeEvent[], type: string) =>
  parts.filter((part) => part.type === type);

describe("codex app-server stream translation", () => {
  const fixtures = readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.replace(/\.jsonl$/, ""));

  it("has fixtures to replay", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)(
    "%s: every emitted part satisfies the harness stream-part schema",
    (name) => {
      const { parts } = replay(name);
      for (const part of parts) {
        // `bridge-thread` is a bridge PROTOCOL frame, not a stream part — the
        // framework routes it separately, so it is exempt by design.
        if (part.type === "bridge-thread") continue;
        const result = harnessV1StreamPartSchema.safeParse(part);
        if (!result.success) {
          throw new Error(
            `invalid ${String(part.type)} part: ${JSON.stringify(
              result.error.issues,
            )}\npart: ${JSON.stringify(part)}`,
          );
        }
      }
    },
  );

  it.each(fixtures)("%s: closes every block it opens", (name) => {
    const { parts } = replay(name);
    for (const [start, end] of [
      ["text-start", "text-end"],
      ["reasoning-start", "reasoning-end"],
    ] as const) {
      const opened = partsOfType(parts, start).map((p) => p.id);
      const closed = partsOfType(parts, end).map((p) => p.id);
      expect(closed.sort()).toEqual(opened.sort());
    }
  });

  it.each(fixtures)("%s: emits exactly one finish, last", (name) => {
    const { parts } = replay(name);
    const finishes = partsOfType(parts, "finish");
    expect(finishes).toHaveLength(1);
    expect(parts.at(-1)?.type).toBe("finish");
  });

  it.each(fixtures)("%s: never emits two tool-calls for one id", (name) => {
    const { parts } = replay(name);
    const ids = partsOfType(parts, "tool-call").map((p) => p.toolCallId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The ordering guarantee, and the reason `ensureToolCall` exists. Codex sends
  // the approval BEFORE `item/started`, and the framework throws on an approval
  // for a tool call it has not seen — so a translator that waited for the item
  // would fail every approved turn.
  it("emits the tool-call before the approval that references it", () => {
    const { parts, approvals } = replay("command-approved");
    expect(approvals).not.toHaveLength(0);
    for (const approval of approvals) {
      const callIndex = parts.findIndex(
        (part) =>
          part.type === "tool-call" && part.toolCallId === approval.toolCallId,
      );
      const approvalIndex = parts.findIndex(
        (part) =>
          part.type === "tool-approval-request" &&
          part.approvalId === approval.approvalId,
      );
      expect(callIndex).toBeGreaterThanOrEqual(0);
      expect(approvalIndex).toBeGreaterThan(callIndex);
    }
  });

  it("does not emit a second tool-call when the item arrives after its approval", () => {
    const { parts } = replay("command-approved");
    const calls = partsOfType(parts, "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("bash");
    expect(calls[0]?.nativeName).toBe("exec_command");
    // The wire type is a JSON STRING, not an object.
    expect(typeof calls[0]?.input).toBe("string");
    expect(JSON.parse(String(calls[0]?.input))).toMatchObject({
      command: expect.stringContaining("probe.txt"),
    });
  });

  it("reports a declined command as an errored tool result", () => {
    const { parts } = replay("command-declined");
    const results = partsOfType(parts, "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.result).toMatchObject({ status: "declined" });
  });

  it("reports an approved command as a successful tool result", () => {
    const { parts } = replay("command-approved");
    const results = partsOfType(parts, "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBeUndefined();
    expect(results[0]?.result).toMatchObject({ status: "completed" });
  });

  it("streams reasoning and text as separate blocks", () => {
    const { parts } = replay("text-and-reasoning");
    const reasoning = partsOfType(parts, "reasoning-delta")
      .map((p) => p.delta)
      .join("");
    const text = partsOfType(parts, "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(text).toContain("considered answer");
    // Reasoning must not leak into the assistant message.
    expect(text).not.toContain("First I consider");
  });

  it("carries the turn's token usage on finish", () => {
    const { parts } = replay("command-approved");
    const finish = partsOfType(parts, "finish")[0] as
      | {
          totalUsage?: {
            inputTokens?: Record<string, number>;
            outputTokens?: Record<string, number>;
          };
        }
      | undefined;
    expect(finish?.totalUsage?.inputTokens?.total).toBeGreaterThan(0);
    expect(finish?.totalUsage?.outputTokens?.total).toBeGreaterThan(0);
    // The cache breakdown is the thing `codex exec` could not report at all.
    expect(finish?.totalUsage?.inputTokens?.cacheRead).toBeGreaterThan(0);
    expect(finish?.totalUsage?.outputTokens?.reasoning).toBeGreaterThan(0);
  });

  it("forwards the unknown-model warning instead of swallowing it", () => {
    const { warnings } = replay("command-approved");
    // app-server says so out loud; `codex exec` silently ran with no tools.
    expect(warnings.join(" ")).toMatch(/Model metadata .* not found/);
  });

  it("reports an interrupted turn as a non-stop finish", () => {
    const parts: BridgeEvent[] = [];
    const translator = createStreamTranslator({
      emit: (part) => parts.push(part),
      emitWarning: () => {},
      emitError: () => {},
      relayServerName: RELAY_MCP_SERVER_NAME,
      emitRaw: false,
    });
    translator.finishTurn({ status: "interrupted" });
    const finish = partsOfType(parts, "finish")[0] as
      { finishReason?: { unified?: string; raw?: string } } | undefined;
    expect(finish?.finishReason?.unified).toBe("other");
    expect(finish?.finishReason?.raw).toBe("interrupted");
  });

  it("emits raw passthrough for every notification when enabled", () => {
    const parts: BridgeEvent[] = [];
    const translator = createStreamTranslator({
      emit: (part) => parts.push(part),
      emitWarning: () => {},
      emitError: () => {},
      relayServerName: RELAY_MCP_SERVER_NAME,
    });
    // A notification this translator models nothing for is still visible.
    translator.handleNotification({
      method: "thread/queue/changed",
      params: { threadId: "t" },
    });
    expect(typesOf(parts)).toContain("raw");
  });
});

/**
 * Cases the scripted provider cannot produce, marked as CONSTRUCTED.
 *
 * `apply_patch` is not a function tool the model can be told to call (see
 * `fixtures/README.md`), so a fileChange item never appears in a recorded
 * stream. These frames are hand-built from the committed protocol schema. They
 * test the translator's handling, and they are honest about not being evidence
 * of what codex sends.
 */
describe("constructed frames (not recorded — see fixtures/README.md)", () => {
  function fresh() {
    const parts: BridgeEvent[] = [];
    const translator = createStreamTranslator({
      emit: (part) => parts.push(part),
      emitWarning: () => {},
      emitError: () => {},
      relayServerName: RELAY_MCP_SERVER_NAME,
      emitRaw: false,
    });
    return { parts, translator };
  }

  it("turns a fileChange item into a tool pair", () => {
    const { parts, translator } = fresh();
    const item = {
      type: "fileChange",
      id: "item_1",
      status: "completed",
      changes: [
        { path: "/w/a.ts", diff: "", kind: { type: "add" } },
        { path: "/w/b.ts", diff: "", kind: { type: "update" } },
      ],
    };
    translator.handleNotification({ method: "item/started", params: { item } });
    translator.handleNotification({
      method: "item/completed",
      params: { item },
    });
    const call = parts.find((p) => p.type === "tool-call");
    expect(call?.toolName).toBe("fileChange");
    expect(call?.nativeName).toBe("apply_patch");
    const result = parts.find((p) => p.type === "tool-result");
    expect(result?.result).toMatchObject({
      status: "completed",
      changes: [
        { path: "/w/a.ts", kind: "add" },
        { path: "/w/b.ts", kind: "update" },
      ],
    });
  });

  it("maps patchUpdated entries onto file-change parts", () => {
    const { parts, translator } = fresh();
    translator.handleNotification({
      method: "item/fileChange/patchUpdated",
      params: {
        itemId: "item_1",
        changes: [
          { path: "/w/new.ts", kind: { type: "add" } },
          { path: "/w/gone.ts", kind: { type: "delete" } },
          { path: "/w/same.ts", kind: { type: "update" } },
        ],
      },
    });
    expect(partsOfType(parts, "file-change")).toEqual([
      { type: "file-change", event: "create", path: "/w/new.ts" },
      { type: "file-change", event: "delete", path: "/w/gone.ts" },
      { type: "file-change", event: "modify", path: "/w/same.ts" },
    ]);
  });

  it("suppresses the relay's own MCP items so host tools are not doubled", () => {
    const { parts, translator } = fresh();
    const relayItem = {
      type: "mcpToolCall",
      id: "item_relay",
      server: RELAY_MCP_SERVER_NAME,
      tool: "weather__get_forecast",
      arguments: { city: "Paris" },
      status: "completed",
      result: { content: [] },
    };
    translator.handleNotification({
      method: "item/started",
      params: { item: relayItem },
    });
    translator.handleNotification({
      method: "item/completed",
      params: { item: relayItem },
    });
    expect(partsOfType(parts, "tool-call")).toHaveLength(0);
    expect(partsOfType(parts, "tool-result")).toHaveLength(0);
  });

  it("still surfaces a NON-relay MCP call, as a dynamic tool", () => {
    const { parts, translator } = fresh();
    const item = {
      type: "mcpToolCall",
      id: "item_other",
      server: "someone-elses-server",
      tool: "do_thing",
      arguments: { a: 1 },
      status: "completed",
      result: { ok: true },
    };
    translator.handleNotification({ method: "item/started", params: { item } });
    translator.handleNotification({
      method: "item/completed",
      params: { item },
    });
    const call = parts.find((p) => p.type === "tool-call");
    expect(call?.toolName).toBe("someone-elses-server__do_thing");
    expect(call?.dynamic).toBe(true);
  });

  it("emits the whole assistant text when nothing streamed", () => {
    const { parts, translator } = fresh();
    // The non-streamed-response case: no deltas, all the text on the item.
    translator.handleNotification({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", id: "msg_1", text: "All at once." },
      },
    });
    expect(
      partsOfType(parts, "text-delta")
        .map((p) => p.delta)
        .join(""),
    ).toBe("All at once.");
    expect(partsOfType(parts, "text-end")).toHaveLength(1);
  });

  it("emits only the REMAINDER when the stream was truncated", () => {
    const { parts, translator } = fresh();
    translator.handleNotification({
      method: "item/agentMessage/delta",
      params: { itemId: "msg_1", delta: "Half " },
    });
    translator.handleNotification({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", id: "msg_1", text: "Half a message." },
      },
    });
    expect(
      partsOfType(parts, "text-delta")
        .map((p) => p.delta)
        .join(""),
    ).toBe("Half a message.");
  });

  it("treats a retryable error as a warning, not a turn failure", () => {
    const warnings: string[] = [];
    const errors: unknown[] = [];
    const translator = createStreamTranslator({
      emit: () => {},
      emitWarning: ({ message }) => warnings.push(message),
      emitError: ({ error }) => errors.push(error),
      relayServerName: RELAY_MCP_SERVER_NAME,
      emitRaw: false,
    });
    translator.handleNotification({
      method: "error",
      params: { error: { message: "rate limited" }, willRetry: true },
    });
    expect(warnings).toEqual(["rate limited"]);
    expect(errors).toHaveLength(0);

    translator.handleNotification({
      method: "error",
      params: { error: { message: "fatal" }, willRetry: false },
    });
    expect(errors).toEqual(["fatal"]);
  });
});
