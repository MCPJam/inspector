import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatRegistryDirectoryServerHuman,
  formatRegistryInstallHuman,
} from "../src/lib/registry-render.js";

describe("registry human formatters", () => {
  test("show prints the pin, auth posture, and a local probe command", () => {
    const text = formatRegistryDirectoryServerHuman({
      id: "cs_linear_1",
      source: "claude",
      serverName: "linear",
      displayName: "Linear",
      description: "Issue tracking",
      authPosture: "oauth",
      verifiedTier: "verified",
      endpointKind: "single",
      remoteUrl: "https://mcp.linear.app/mcp",
      latestContentHash: "hash_abc",
    });
    assert.match(text, /latestContentHash: hash_abc/);
    assert.match(text, /authPosture: oauth/);
    assert.match(text, /verifiedTier: verified/);
    assert.match(text, /mcpjam server probe --url https:\/\/mcp\.linear\.app\/mcp/);
    assert.match(text, /--expected-content-hash hash_abc/);
  });

  test("show surfaces tenant regex and options instead of dumping the raw row", () => {
    const tenant = formatRegistryDirectoryServerHuman({
      id: "cs_tenant",
      source: "chatgpt",
      serverName: "acme",
      endpointKind: "tenant",
      remoteUrlRegex: "^https://([a-z]+)\\.acme\\.com/mcp$",
      remoteUrlHint: "Replace the subdomain with your workspace slug",
      unavailableReason: "needs_tenant_url",
      latestContentHash: "hash_tenant",
    });
    assert.match(tenant, /endpointKind: tenant/);
    assert.match(tenant, /remoteUrlRegex:/);
    assert.match(tenant, /remoteUrlHint:/);
    assert.match(tenant, /unavailableReason: needs_tenant_url/);
    assert.doesNotMatch(tenant, /mcpjam server probe/);

    const options = formatRegistryDirectoryServerHuman({
      id: "cs_opts",
      source: "claude",
      serverName: "multi",
      endpointKind: "options",
      remoteUrlOptions: [
        "https://a.example/mcp",
        "https://b.example/mcp",
      ],
      latestContentHash: "hash_opts",
    });
    assert.match(options, /remoteUrlOptions: https:\/\/a\.example\/mcp, https:\/\/b\.example\/mcp/);
  });

  test("install prints runnable follow-up commands, and the OAuth link when present", () => {
    const created = formatRegistryInstallHuman(
      {
        serverId: "srv_1",
        serverName: "linear",
        outcome: "created",
        nextSteps: {
          connectionStatusOp: "get_project_server_connection_status",
          connectLinkUrl: "https://app.mcpjam.test/connect/server/tok",
        },
      },
      { project: "proj-alpha", endpointUrl: "https://mcp.linear.app/mcp" },
    );
    assert.match(created, /Installed linear \(created\)/);
    assert.match(created, /not a live connection/);
    // Follow-ups are commands a CLI user can type, not SDK operation names.
    assert.doesNotMatch(created, /get_project_server_connection_status/);
    assert.match(created, /mcpjam cloud projects status --project proj-alpha/);
    assert.match(
      created,
      /mcpjam cloud projects servers connect --server srv_1 --url https:\/\/mcp\.linear\.app\/mcp --project proj-alpha/,
    );
    assert.doesNotMatch(created, /<endpoint-url>/);
    assert.match(created, /https:\/\/app\.mcpjam\.test\/connect\/server\/tok/);
  });

  test("install falls back to a placeholder URL and omits --project under automatic selection", () => {
    const reconnected = formatRegistryInstallHuman({
      serverId: "srv_2",
      serverName: "acme",
      outcome: "reconnected",
      nextSteps: {
        connectionStatusOp: "get_project_server_connection_status",
      },
    });
    assert.match(reconnected, /Installed acme \(reconnected\)/);
    assert.match(reconnected, /mcpjam cloud projects status\n/);
    assert.match(
      reconnected,
      /mcpjam cloud projects servers connect --server srv_2 --url <endpoint-url>\n?/,
    );
    assert.doesNotMatch(reconnected, /--project/);
    assert.doesNotMatch(reconnected, /Finish OAuth/);
  });

  test("install surfaces a failed OAuth connect-link mint instead of dropping it", () => {
    const text = formatRegistryInstallHuman({
      serverId: "srv_3",
      serverName: "linear",
      outcome: "created",
      nextSteps: {
        connectionStatusOp: "get_project_server_connection_status",
        connectLinkError: "connect-link mint failed",
      },
    });
    assert.match(text, /OAuth connect-link could not be created \(connect-link mint failed\)/);
    assert.doesNotMatch(text, /Finish OAuth/);
  });
});
