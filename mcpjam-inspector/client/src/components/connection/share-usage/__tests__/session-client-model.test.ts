import { describe, expect, it } from "vitest";
import {
  clientLabelForSession,
  modelLabelForSession,
  sessionClientModelLabel,
} from "../session-client-model";

/**
 * The words a session detail uses to say what ran. Both products print the
 * same string, so the composition rules live here rather than in either
 * surface.
 */
describe("clientLabelForSession", () => {
  it("prefers the client's brand word over the host's nickname", () => {
    // A nickname is what the workspace called its host row; the brand word is
    // what the reader is actually asking about.
    expect(
      clientLabelForSession({
        hostStyle: "chatgpt",
        hostName: "Emmanuel's staging bot",
      }),
    ).toBe("ChatGPT");
  });

  it("falls back to the nickname for a style no preset claims", () => {
    expect(
      clientLabelForSession({ hostStyle: "byo-host-42", hostName: "Acme Bot" }),
    ).toBe("Acme Bot");
  });

  it("is null when the session names neither", () => {
    expect(clientLabelForSession({})).toBeNull();
    expect(clientLabelForSession({ hostName: "   " })).toBeNull();
  });
});

describe("modelLabelForSession", () => {
  const catalog = [
    { id: "openai/gpt-5", name: "GPT-5", provider: "openai" as const },
  ];

  it("uses the catalog's curated name", () => {
    expect(modelLabelForSession("openai/gpt-5", catalog)).toBe("GPT-5");
  });

  it("resolves a BYOK model id from the static list", () => {
    expect(modelLabelForSession("claude-opus-5")).toBe("Claude Opus 5");
  });

  it("resolves a bare hosted id to the catalog's curated name", () => {
    // Sessions persist both shapes, and the bare one carries no provider for
    // `getCanonicalModelId` to look under — without the suffix match this read
    // back as the raw id on 148 of the 173 hosted models.
    expect(
      modelLabelForSession("gpt-oss-120b", [
        {
          id: "openai/gpt-oss-120b",
          name: "GPT-OSS 120B",
          provider: "openai" as const,
        },
      ]),
    ).toBe("GPT-OSS 120B");
    // Real snapshot entry, no injected catalog — the example from the task.
    expect(modelLabelForSession("claude-haiku-4.5")).toBe("Claude Haiku 4.5");
  });

  it("refuses to guess when two vendors claim the same bare name", () => {
    // A plain id beats a confidently wrong vendor label.
    expect(
      modelLabelForSession("mystery-7b", [
        { id: "openai/mystery-7b", name: "OpenAI Mystery", provider: "openai" as const },
        { id: "acme/mystery-7b", name: "Acme Mystery", provider: "acme" as const },
      ]),
    ).toBe("mystery-7b");
  });

  it("falls back to the id tail for a model no catalog knows", () => {
    // Better the string the Raw tab would have shown than nothing at all.
    expect(modelLabelForSession("acme/experimental-7b")).toBe(
      "experimental-7b",
    );
  });

  it("is null when the session recorded no model", () => {
    expect(modelLabelForSession(undefined)).toBeNull();
    expect(modelLabelForSession("  ")).toBeNull();
  });
});

describe("sessionClientModelLabel", () => {
  it("joins client and model", () => {
    expect(sessionClientModelLabel("ChatGPT", "GPT-5")).toBe("ChatGPT · GPT-5");
  });

  it("prints whichever half is known, never a placeholder", () => {
    expect(sessionClientModelLabel(null, "Claude Haiku 4.5")).toBe(
      "Claude Haiku 4.5",
    );
    expect(sessionClientModelLabel("Claude", null)).toBe("Claude");
    expect(sessionClientModelLabel(null, null)).toBeNull();
  });
});
