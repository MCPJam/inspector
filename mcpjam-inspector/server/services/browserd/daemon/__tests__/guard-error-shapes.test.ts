import { describe, expect, it } from "vitest";
import type { BrowserCommand, BrowserCommandResult } from "../../protocol";
import { guardErrorShapes } from "../browser-driver";

const command = {} as BrowserCommand;

describe("guardErrorShapes", () => {
  it("redacts a credential shape in the error and keeps the rest", async () => {
    const guarded = guardErrorShapes(async () => ({
      ok: false,
      error: "fetch failed ?api_key=abcdef1234567890",
    }));
    const result = await guarded(command);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("abcdef1234567890");
    expect(result.error).toContain("[redacted]");
    expect(result.error).toContain("fetch failed");
  });

  it("passes an ok result through unchanged", async () => {
    const ok: BrowserCommandResult = { ok: true, output: { url: "https://x" } };
    const guarded = guardErrorShapes(async () => ok);
    expect(await guarded(command)).toBe(ok);
  });
});
