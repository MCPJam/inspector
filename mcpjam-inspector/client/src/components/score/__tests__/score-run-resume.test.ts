import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readScoreRunResume, writeScoreRunResume } from "../score-run-resume";

describe("score run resume", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("preserves the delivery email across an OAuth redirect", () => {
    writeScoreRunResume({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
      deliveryEmail: "dev@acme.com",
    });

    expect(readScoreRunResume()).toMatchObject({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
      deliveryEmail: "dev@acme.com",
    });
  });

  it("still reads older records without an email", () => {
    writeScoreRunResume({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
    });

    expect(readScoreRunResume()).toMatchObject({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
    });
    expect(readScoreRunResume()?.deliveryEmail).toBeUndefined();
  });

  it("expires an abandoned authorization detour", () => {
    const startedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(startedAt);
    writeScoreRunResume({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
      deliveryEmail: "dev@acme.com",
    });

    vi.mocked(Date.now).mockReturnValue(startedAt + 16 * 60_000);

    expect(readScoreRunResume()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    "not json",
    "null",
    JSON.stringify({ serverUrl: 42 }),
    JSON.stringify({ serverUrl: "https://mcp.acme.com/mcp" }),
    JSON.stringify({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
    }),
    JSON.stringify({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
      startedAt: "yesterday",
    }),
  ])("discards an invalid record: %s", (record) => {
    sessionStorage.setItem("mcpjam-score-run-resume", record);

    expect(readScoreRunResume()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("drops a non-string delivery email rather than resuming with it", () => {
    sessionStorage.setItem(
      "mcpjam-score-run-resume",
      JSON.stringify({
        serverUrl: "https://mcp.acme.com/mcp",
        serverName: "score-acme",
        deliveryEmail: 42,
        startedAt: Date.now(),
      }),
    );

    expect(readScoreRunResume()).toEqual({
      serverUrl: "https://mcp.acme.com/mcp",
      serverName: "score-acme",
      startedAt: expect.any(Number),
    });
  });

  it("stays silent when sessionStorage is unavailable", () => {
    const unavailable = () => {
      throw new Error("storage disabled");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(unavailable);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(unavailable);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(unavailable);

    expect(() =>
      writeScoreRunResume({
        serverUrl: "https://mcp.acme.com/mcp",
        serverName: "score-acme",
      }),
    ).not.toThrow();
    expect(readScoreRunResume()).toBeNull();
  });
});
