import { describe, expect, it } from "vitest";
import { conformanceRunTargetName } from "../conformance-run-target";

const names = new Map([["srv_1", "Excalidraw"]]);

describe("conformanceRunTargetName", () => {
  it("uses the saved server's name while the project has the server", () => {
    expect(
      conformanceRunTargetName(
        { targetKey: "server:srv_1", serverId: "srv_1" },
        names,
      ),
    ).toBe("Excalidraw");
  });

  it("falls back to the id of a saved server the project no longer has", () => {
    expect(
      conformanceRunTargetName(
        { targetKey: "server:srv_gone", serverId: "srv_gone" },
        names,
      ),
    ).toBe("srv_gone");
  });

  it("names a CLI or SDK run by the URL it ran against", () => {
    expect(
      conformanceRunTargetName({
        targetKey: "url:https://mcp.example.com/mcp",
        serverId: null,
      }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("names a run by its ref", () => {
    expect(
      conformanceRunTargetName({ targetKey: "ref:staging", serverId: null }),
    ).toBe("staging");
  });

  it("names a GitHub run by its repository, never by its config id", () => {
    expect(
      conformanceRunTargetName({
        targetKey: "github_repo:cfg_123",
        serverId: null,
        ciMetadata: { repository: "acme/weather-mcp" },
      }),
    ).toBe("acme/weather-mcp");
    expect(
      conformanceRunTargetName({
        targetKey: "github_repo:cfg_123",
        serverId: null,
        ciMetadata: null,
      }),
    ).toBe("GitHub repository");
  });
});
