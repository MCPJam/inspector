/**
 * A directly-loaded skill is injected into the transcript as a synthetic
 * `loadSkill` tool call, and that call's id goes to the provider verbatim on
 * every subsequent turn.
 *
 * Anthropic validates `tool_use.id` against `^[a-zA-Z0-9_-]+$` and rejects the
 * whole request otherwise — so an id built from a name containing anything
 * else does not degrade, it makes the conversation uncontinuable:
 * `messages.5.content.1.tool_use.id: String should match pattern`. A
 * server-served skill (SEP-2640) is addressed by a namespaced `<server>/<skill>`
 * ref, so it carries exactly such a character.
 */
import { describe, expect, it } from "vitest";
import { buildSkillToolMessages } from "../chat-helpers";

/** The pattern the provider enforces. */
const PROVIDER_TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;

function toolCallIds(messages: ReturnType<typeof buildSkillToolMessages>) {
  return messages.flatMap((message) =>
    message.parts
      .filter(
        (part): part is Extract<typeof part, { toolCallId: string }> =>
          "toolCallId" in part && typeof part.toolCallId === "string"
      )
      .map((part) => part.toolCallId)
  );
}

describe("synthetic loadSkill tool-call ids", () => {
  it("stays inside the provider's charset for a namespaced server skill", () => {
    const messages = buildSkillToolMessages([
      {
        name: "staging/run-mcpjam-evals",
        content: "# Run evals\n",
      } as never,
    ]);

    const ids = toolCallIds(messages);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(PROVIDER_TOOL_USE_ID);
  });

  it("keeps the name legible rather than dropping it", () => {
    const [message] = buildSkillToolMessages([
      { name: "staging/run-mcpjam-evals", content: "x" } as never,
    ]);
    const [id] = toolCallIds([message!]);
    // The name is in the id for debuggability; only the offending character
    // is replaced.
    expect(id).toContain("staging_run-mcpjam-evals");
  });

  it("leaves an already-valid cloud skill name untouched", () => {
    const [message] = buildSkillToolMessages([
      { name: "run-mcpjam-evals", content: "x" } as never,
    ]);
    const [id] = toolCallIds([message!]);
    expect(id).toContain("skill-load-run-mcpjam-evals-");
    expect(id).toMatch(PROVIDER_TOOL_USE_ID);
  });

  it("covers supporting-file calls too", () => {
    const messages = buildSkillToolMessages([
      {
        name: "staging/run-mcpjam-evals",
        content: "x",
        selectedFiles: [{ path: "references/triage.md", content: "y" }],
      } as never,
    ]);
    const ids = toolCallIds(messages);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) expect(id).toMatch(PROVIDER_TOOL_USE_ID);
  });
});
