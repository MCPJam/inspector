import { describe, expect, it } from "vitest";
import {
  INITIAL_SCORE_RUN_DRAFT,
  acceptScoreDeliveryEmail,
  acceptScoreServerUrl,
  restoreScoreRunDraft,
  scoreRunDraftReducer,
} from "../score-run-draft";

describe("score run draft", () => {
  it("edits fields without hidden side effects", () => {
    const withUrl = scoreRunDraftReducer(INITIAL_SCORE_RUN_DRAFT, {
      type: "edit-url",
      value: "https://mcp.acme.com/mcp",
    });
    const withEmail = scoreRunDraftReducer(withUrl, {
      type: "edit-email",
      value: "dev@acme.com",
    });

    expect(withEmail).toEqual({
      urlInput: "https://mcp.acme.com/mcp",
      emailInput: "dev@acme.com",
    });
    expect(INITIAL_SCORE_RUN_DRAFT).toEqual({ urlInput: "", emailInput: "" });
  });

  it("accepts and normalizes a server URL", () => {
    const result = acceptScoreServerUrl({
      urlInput: "  https://mcp.acme.com/mcp  ",
      emailInput: "",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        urlInput: "https://mcp.acme.com/mcp",
        emailInput: "",
        serverUrl: "https://mcp.acme.com/mcp",
      },
    });
  });

  it("revokes URL acceptance when the URL input changes", () => {
    const accepted = acceptScoreServerUrl({
      urlInput: "https://mcp.acme.com/mcp",
      emailInput: "dev@acme.com",
    });
    if (!accepted.ok) throw new Error("expected the URL to be accepted");

    const edited = scoreRunDraftReducer(accepted.value, {
      type: "edit-url",
      value: "https://mcp.other.com/mcp",
    });

    expect(edited.serverUrl).toBeUndefined();
    // The regression this guards: a stale `serverUrl` would have minted an
    // intent for the server the visitor just replaced.
    expect(acceptScoreDeliveryEmail(edited)).toEqual({ ok: false });
  });

  it.each([
    [""],
    ["   "],
    ["not a url"],
    ["https://"],
    ["javascript:alert(1)"],
  ])("rejects the URL transition for %j", (urlInput) => {
    expect(acceptScoreServerUrl({ urlInput, emailInput: "" })).toEqual({
      ok: false,
    });
  });

  it.each([[""], ["   "], ["not-an-email"]])(
    "rejects the email transition for %j",
    (emailInput) => {
      expect(
        acceptScoreDeliveryEmail({
          urlInput: "https://mcp.acme.com/mcp",
          emailInput,
          serverUrl: "https://mcp.acme.com/mcp",
        }),
      ).toEqual({ ok: false });
    },
  );

  it("rejects an email submitted before a URL is accepted", () => {
    expect(
      acceptScoreDeliveryEmail({
        urlInput: "https://mcp.acme.com/mcp",
        emailInput: "dev@acme.com",
      }),
    ).toEqual({ ok: false });
  });

  it("creates an immutable normalized run intent", () => {
    const draft = {
      urlInput: "https://mcp.acme.com/mcp",
      emailInput: "  dev@acme.com  ",
      serverUrl: "https://mcp.acme.com/mcp",
    };

    expect(acceptScoreDeliveryEmail(draft)).toEqual({
      ok: true,
      value: {
        draft: { ...draft, emailInput: "dev@acme.com" },
        intent: {
          serverUrl: "https://mcp.acme.com/mcp",
          deliveryEmail: "dev@acme.com",
        },
      },
    });
    expect(draft.emailInput).toBe("  dev@acme.com  ");
  });

  it("restores complete and legacy OAuth records explicitly", () => {
    const complete = restoreScoreRunDraft({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
      deliveryEmail: "dev@acme.com",
      startedAt: Date.now(),
    });
    const legacy = restoreScoreRunDraft({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
      startedAt: Date.now(),
    });

    expect(complete.kind).toBe("run");
    expect(legacy).toMatchObject({
      kind: "collect-email",
      draft: { serverUrl: "https://mcp.acme.com/mcp", emailInput: "" },
    });
  });

  it("discards a resume record with an invalid URL", () => {
    expect(
      restoreScoreRunDraft({
        serverUrl: "javascript:alert(1)",
        serverName: "bad",
        deliveryEmail: "dev@acme.com",
        startedAt: Date.now(),
      }),
    ).toEqual({ kind: "discard" });
  });
});
