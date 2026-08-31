import { beforeEach, describe, expect, it } from "vitest";
import { readScoreRunResume, writeScoreRunResume } from "../score-run-resume";

describe("score run resume", () => {
  beforeEach(() => sessionStorage.clear());

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
});
