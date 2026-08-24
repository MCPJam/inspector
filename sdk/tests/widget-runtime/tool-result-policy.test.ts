import { describe, expect, it } from "vitest";
import { applyToolResultPolicy } from "../../src/widget-runtime/tool-result-policy";

const result = {
  content: [
    { type: "text", text: "hello" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
    { type: "audio", data: "aGk=", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "x://1", text: "r" } },
    { type: "resource_link", uri: "x://2", name: "link" },
  ],
  structuredContent: { ok: true },
};

describe("applyToolResultPolicy", () => {
  it("returns the SAME object when nothing is dropped", () => {
    // Referential equality matters: consumers memoize on the result, and the
    // common case (a conforming host) must not churn them.
    expect(applyToolResultPolicy(result, undefined)).toBe(result);
    expect(applyToolResultPolicy(result, {})).toBe(result);
    expect(
      applyToolResultPolicy(result, {
        structuredContent: true,
        content: { text: true, image: true },
      })
    ).toBe(result);
  });

  it("drops structuredContent without touching content", () => {
    const out = applyToolResultPolicy(result, { structuredContent: false });
    expect(out).not.toBe(result);
    expect("structuredContent" in out).toBe(false);
    expect(out.content).toBe(result.content);
    // The input is never mutated — the original still carries both halves.
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it("drops only the content kinds set to false", () => {
    const out = applyToolResultPolicy(result, {
      content: { image: false, resourceLink: false },
    });
    expect(out.content.map((b) => b.type)).toEqual([
      "text",
      "audio",
      "resource",
    ]);
    expect(out.structuredContent).toEqual({ ok: true });
  });

  it("maps resource_link, whose wire name differs from its config key", () => {
    const out = applyToolResultPolicy(result, {
      content: { resourceLink: false },
    });
    expect(out.content.some((b) => b.type === "resource_link")).toBe(false);
    expect(out.content).toHaveLength(4);
  });

  it("keeps blocks the policy cannot describe", () => {
    // A future spec kind must not vanish just because this host config
    // predates it — that would read as host breakage in the probe.
    const withUnknown = {
      content: [{ type: "text", text: "a" }, { type: "video-of-the-future" }],
    };
    const out = applyToolResultPolicy(withUnknown, {
      content: { text: false },
    });
    expect(out.content.map((b) => b.type)).toEqual(["video-of-the-future"]);
  });

  it("survives results with no content array", () => {
    const bare = { structuredContent: { a: 1 } };
    expect(
      applyToolResultPolicy(bare, { content: { text: false } })
    ).toBe(bare);
    expect(
      "structuredContent" in
        applyToolResultPolicy(bare, { structuredContent: false })
    ).toBe(false);
  });
});
