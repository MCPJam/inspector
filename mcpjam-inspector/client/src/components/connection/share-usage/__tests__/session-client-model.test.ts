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
