import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorizedManager } from "../auth.js";
import { WebRouteError } from "../errors.js";

// The authorize answer withholds a saved token and says which rule did it. A
// hosted-only account's rule is the account's own, which no organization admin
// can change, so its copy must not send anyone to the export policy.

function stubAuthorize(extra: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        results: {
          "server-1": {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            oauthUnavailableReason: "credential_export_denied",
            ...extra,
            serverConfig: {
              name: "Markets",
              transportType: "http",
              url: "https://mcp.example.com/mcp",
              useOAuth: true,
            },
          },
        },
      }),
    ),
  );
}

async function refusal(): Promise<WebRouteError> {
  const error = await createAuthorizedManager(
    {},
    "bearer",
    "project-1",
    ["server-1"],
    1_000,
  ).catch((caught: unknown) => caught);
  if (!(error instanceof WebRouteError)) throw new Error("expected a refusal");
  return error;
}

describe("an export refusal names the rule that refused", () => {
  beforeEach(() => vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("says a hosted-only account can be used only by hosted runs", async () => {
    stubAuthorize({ oauthUnavailablePolicy: "hostedOnlyAccount" });
    const error = await refusal();
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      `"Markets" uses an account that only MCPJam-hosted runs can use, so its token can't be used from here. Run it as a hosted run, or connect a separate account for local use.`,
    );
    expect(error.details).toMatchObject({
      exportDenied: true,
      policy: "hostedOnlyAccount",
      serverId: "server-1",
    });
  });

  it.each([{}, { oauthUnavailablePolicy: "credentialExportPolicy" }])(
    "keeps the organization policy copy for %j",
    async (extra) => {
      stubAuthorize(extra);
      const error = await refusal();
      expect(error.message).toContain(
        "Ask an organization admin to change the credential export policy.",
      );
      expect(error.details).toMatchObject({
        exportDenied: true,
        policy: "credentialExportPolicy",
      });
    },
  );
});
