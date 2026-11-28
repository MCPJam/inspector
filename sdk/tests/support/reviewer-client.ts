/**
 * A reviewer account's connection, faked: the tools it lists, what each call
 * answers, and a log of every call, so a test can say exactly what ran.
 */

import type { DirectoryReviewerClient } from "../../src/directory-readiness/reviewer/gather.js";
import type { DirectoryToolEvidence } from "../../src/directory-readiness/mcp-dial.js";

export type FakeAnswer =
  { result: Record<string, unknown> } | { error: string };

export function readTool(
  name: string,
  inputSchema: Record<string, unknown> = { type: "object", properties: {} },
  annotations: Record<string, unknown> = {
    readOnlyHint: true,
    destructiveHint: false,
  }
): DirectoryToolEvidence {
  return { name, inputSchema, annotations };
}

/** A successful call whose structured result is `value`. */
export function structured(value: unknown): FakeAnswer {
  return { result: { structuredContent: value, content: [] } };
}

/** A successful call answered only in text. */
export function text(value: string, isError = false): FakeAnswer {
  return { result: { content: [{ type: "text", text: value }], isError } };
}

export function fakeReviewerClient(
  tools: DirectoryToolEvidence[],
  answers: Record<
    string,
    FakeAnswer | ((args: Record<string, unknown>) => FakeAnswer)
  >,
  complete = true
): DirectoryReviewerClient & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    tools,
    complete,
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      const answer = answers[name];
      if (!answer) return { error: `no fake answer for ${name}` };
      return typeof answer === "function" ? answer(args) : answer;
    },
  };
}
