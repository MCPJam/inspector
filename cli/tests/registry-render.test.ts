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

  test("install prints nextSteps as follow-up commands, and the OAuth link when present", () => {
    const created = formatRegistryInstallHuman({
      serverId: "srv_1",
      serverName: "linear",
      outcome: "created",
      nextSteps: {
        connectionStatusOp: "get_project_server_connection_status",
        connectLinkUrl: "https://app.mcpjam.test/connect/server/tok",
      },
    });
    assert.match(created, /Installed linear \(created\)/);
    assert.match(created, /not a live connection/);
    assert.match(created, /get_project_server_connection_status/);
    assert.match(created, /mcpjam cloud projects servers connect --server srv_1/);
    assert.match(created, /https:\/\/app\.mcpjam\.test\/connect\/server\/tok/);

    const jsonShape = {
      serverId: "srv_1",
      serverName: "linear",
      outcome: "reconnected",
      nextSteps: {
        connectionStatusOp: "get_project_server_connection_status" as const,
      },
    };
    assert.equal(jsonShape.nextSteps.connectionStatusOp, "get_project_server_connection_status");
    assert.equal("connectLinkUrl" in jsonShape.nextSteps, false);
  });
});
