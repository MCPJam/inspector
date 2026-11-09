import { expect, it, vi } from "vitest";
import { submitServerDraft } from "../server-connection-submission";

const draft = {
  name: "Asana",
  type: "http" as const,
  url: "https://example.com/mcp",
};

it("does not accept an unacknowledged or rejected save", async () => {
  expect(await submitServerDraft(() => undefined, draft)).toBe(false);
  expect(
    await submitServerDraft(() => {
      throw new Error("preflight");
    }, draft),
  ).toBe(false);
  expect(
    await submitServerDraft(async () => {
      throw new Error("save");
    }, draft),
  ).toBe(false);
});

it("accepts at the owner's acknowledgement rather than waiting for the connection", async () => {
  let finish: () => void = vi.fn();
  const connecting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  expect(
    await submitServerDraft((_data, options) => {
      options?.onAccepted?.();
      return connecting;
    }, draft),
  ).toBe(true);
  finish();
});

it("preserves the submitted draft and suppresses duplicate error toasts", async () => {
  await submitServerDraft((data, options) => {
    expect(data).toBe(draft);
    expect(options?.suppressErrorToast).toBe(true);
  }, draft);
  expect(draft.url).toBe("https://example.com/mcp");
});
