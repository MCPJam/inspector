import { describe, expect, it } from "vitest";
import { filterAndRemapReplayConfigs } from "../evals";

describe("filterAndRemapReplayConfigs", () => {
  it("filters unrelated servers and remaps stored server ids", () => {
    expect(
      filterAndRemapReplayConfigs(
        [
          {
            serverId: "srv_asana",
            url: "https://asana.example/mcp",
            accessToken: "at_123",
          },
          {
            serverId: "srv_github",
            url: "https://github.example/mcp",
            accessToken: "at_456",
          },
        ],
        ["srv_asana"],
        ["asana"],
      ),
    ).toEqual([
      {
        serverId: "asana",
        url: "https://asana.example/mcp",
        accessToken: "at_123",
      },
    ]);
  });
});
