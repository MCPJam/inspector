import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRegistrationStrategies } from "../src/oauth/authorization-plan.js";
import type { OAuthConformanceConfig } from "../src/oauth-conformance/types.js";
import type { ConformanceRunProgress } from "../src/conformance-run.js";

// The run hands the OAuth suite a settled strategy; what the suite then does
// with it is the runner's own tests. Recording the config the runner gets is
// enough here, and a run that throws keeps every check off the network.
const { constructed, probeMcpServer } = vi.hoisted(() => ({
  constructed: [] as OAuthConformanceConfig[],
  probeMcpServer: vi.fn(),
}));

vi.mock(
  import("../src/oauth-conformance/runner.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    OAuthConformanceTest: class {
      constructor(config: OAuthConformanceConfig) {
        constructed.push(config);
      }
      async run(): Promise<never> {
        throw new Error("stub runner");
      }
    } as never,
  })
);

vi.mock(import("../src/server-probe.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  probeMcpServer,
}));

const { runConformance } = await import("../src/conformance-run.js");

const SERVER_URL = "https://mcp.example.com/mcp";

/** What the probe finds, with the strategies the real probe derives from it. */
function discovers(authorizationServerMetadata: Record<string, unknown>) {
  probeMcpServer.mockImplementation(
    async ({ protocolVersion }: { protocolVersion: string }) => ({
      oauth: {
        required: true,
        optional: false,
        authorizationServerMetadata,
        registrationStrategies: resolveRegistrationStrategies(
          protocolVersion as never,
          authorizationServerMetadata
        ),
      },
    })
  );
}

async function runOAuth(
  oauth: Partial<OAuthConformanceConfig> & { registrationStrategy: "auto" },
  protocolVersion: "2025-06-18" | "2025-11-25"
) {
  const progress: ConformanceRunProgress[] = [];
  await runConformance({
    server: { url: SERVER_URL },
    suites: ["oauth"],
    protocolVersion,
    oauth: {
      serverUrl: SERVER_URL,
      protocolVersion: "2025-11-25",
      auth: { mode: "interactive" },
      ...oauth,
    },
    onProgress: (event) => {
      progress.push(event);
    },
    __suppressTelemetry: true,
  });
  return progress;
}

describe("runConformance settles OAuth registration auto", () => {
  beforeEach(() => {
    constructed.length = 0;
    probeMcpServer.mockReset();
  });

  it("chooses at the run's version: DCR at 2025-06-18, CIMD at 2025-11-25", async () => {
    discovers({
      registration_endpoint: "https://auth.example.com/register",
      client_id_metadata_document_supported: true,
    });

    await runOAuth({ registrationStrategy: "auto" }, "2025-06-18");
    await runOAuth({ registrationStrategy: "auto" }, "2025-11-25");

    expect(
      probeMcpServer.mock.calls.map(([input]) => input.protocolVersion)
    ).toEqual(["2025-06-18", "2025-11-25"]);
    expect(
      constructed.map(({ protocolVersion, registrationStrategy }) => ({
        protocolVersion,
        registrationStrategy,
      }))
    ).toEqual([
      { protocolVersion: "2025-06-18", registrationStrategy: "dcr" },
      { protocolVersion: "2025-11-25", registrationStrategy: "cimd" },
    ]);
  });

  it("uses a pre-registered client without probing the server", async () => {
    await runOAuth(
      {
        registrationStrategy: "auto",
        client: { preregistered: { clientId: "client-id" } },
      },
      "2025-06-18"
    );

    expect(probeMcpServer).not.toHaveBeenCalled();
    expect(constructed[0]?.registrationStrategy).toBe("preregistered");
  });

  it("reports the suite as not run when no registration is usable", async () => {
    discovers({});

    const progress = await runOAuth(
      { registrationStrategy: "auto" },
      "2025-06-18"
    );

    expect(constructed).toEqual([]);
    expect(progress.at(-1)).toMatchObject({
      suiteKind: "oauth",
      status: "failed",
      error: expect.stringContaining(
        "could not find a usable CIMD or DCR flow"
      ),
    });
  });
});
