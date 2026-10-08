import { describe, expect, it } from "vitest";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import {
  HIDDEN_ENVIRONMENT_RETRY_FAILED_MESSAGE,
  hiddenEnvironmentCompositionKey,
  hiddenEnvironmentServerOverride,
  plainHiddenEnvironmentFailure,
  readRecoverableHiddenEnvironmentCode,
  retargetHiddenEnvironmentBody,
  runnablePluginServerIds,
  runnablePluginVersionIds,
  skippedPluginsForNotice,
} from "../hidden-environment";

function row(
  id: string,
  overrides: Partial<ActivePluginRow> = {},
): ActivePluginRow {
  return {
    pluginId: `plg_${id}`,
    pluginVersionId: `ver_${id}`,
    name: id,
    displayName: null,
    status: "active",
    servers: [
      {
        serverId: `srv_${id}`,
        name: id,
        componentKey: "s",
        placement: "remote",
      },
    ],
    skills: [],
    ...overrides,
  };
}

describe("runnable plugins", () => {
  it("keeps active rows with a version, in plugin order, deduped", () => {
    const rows = [
      row("a"),
      row("skipped", { status: "skipped", reason: "needs_auth" }),
      row("noversion", { pluginVersionId: null }),
      row("b", {
        servers: [
          {
            serverId: "srv_a",
            name: "a",
            componentKey: "s",
            placement: "remote",
          },
          {
            serverId: "srv_b",
            name: "b",
            componentKey: "s",
            placement: "remote",
          },
        ],
      }),
    ];
    expect(runnablePluginVersionIds(rows)).toEqual(["ver_a", "ver_b"]);
    expect(runnablePluginServerIds(rows)).toEqual(["srv_a", "srv_b"]);
  });

  it("never treats a plugin with a local or computer component as runnable", () => {
    // The hosted-venue read skips these; this holds even if a read did not.
    const local = row("local", {
      servers: [
        { serverId: "srv_l", name: "l", componentKey: "s", placement: "local" },
      ],
    });
    const mixed = row("mixed", {
      servers: [
        {
          serverId: "srv_r",
          name: "r",
          componentKey: "r",
          placement: "remote",
        },
        {
          serverId: "srv_c",
          name: "c",
          componentKey: "c",
          placement: "computer",
        },
      ],
    });
    expect(runnablePluginVersionIds([local, mixed, row("a")])).toEqual([
      "ver_a",
    ]);
    expect(runnablePluginServerIds([local, mixed, row("a")])).toEqual([
      "srv_a",
    ]);
  });
});

describe("hiddenEnvironmentCompositionKey", () => {
  it("is the same for the same composition and differs on any field", () => {
    const base = { hostId: "h", pluginVersionIds: ["v1", "v2"] };
    expect(hiddenEnvironmentCompositionKey(base)).toBe(
      hiddenEnvironmentCompositionKey({
        ...base,
        pluginVersionIds: ["v1", "v2"],
      }),
    );
    expect(hiddenEnvironmentCompositionKey(base)).not.toBe(
      hiddenEnvironmentCompositionKey({ ...base, hostId: "h2" }),
    );
    // Order is meaningful to the backend's fingerprint, so it is here too.
    expect(hiddenEnvironmentCompositionKey(base)).not.toBe(
      hiddenEnvironmentCompositionKey({
        ...base,
        pluginVersionIds: ["v2", "v1"],
      }),
    );
    expect(hiddenEnvironmentCompositionKey(base)).not.toBe(
      hiddenEnvironmentCompositionKey({ ...base, secretIds: ["s"] }),
    );
  });
});

describe("hiddenEnvironmentServerOverride", () => {
  it("is the chat's servers then the plugins', deduped, and [] when both are empty", () => {
    expect(hiddenEnvironmentServerOverride(["a", "b"], ["p", "a"])).toEqual([
      "a",
      "b",
      "p",
    ]);
    expect(hiddenEnvironmentServerOverride([], [])).toEqual([]);
  });
});

describe("skippedPluginsForNotice", () => {
  it("lists skips the member can act on, never a deliberate disable", () => {
    expect(
      skippedPluginsForNotice([
        row("a"),
        row("off", { status: "skipped", reason: "disabled" }),
        row("auth", {
          status: "skipped",
          reason: "needs_auth",
          displayName: "Auth",
        }),
      ]),
    ).toEqual([
      {
        pluginId: "plg_auth",
        name: "auth",
        displayName: "Auth",
        reason: "needs_auth",
      },
    ]);
  });

  it("says where a placement skip's component would have run", () => {
    const skipped = (placement: "local" | "computer") =>
      row(placement, {
        status: "skipped",
        reason: "placement",
        componentKey: "cad",
        servers: [
          {
            serverId: "srv_r",
            name: "r",
            componentKey: "r",
            placement: "remote",
          },
          { serverId: "srv_x", name: "x", componentKey: "cad", placement },
        ],
      });
    expect(
      skippedPluginsForNotice([skipped("local"), skipped("computer")]).map(
        (plugin) => plugin.placement,
      ),
    ).toEqual(["local", "computer"]);
  });
});

describe("retry helpers", () => {
  function refused(code: string, status = 409) {
    return new Response(
      JSON.stringify({ code: "CONFLICT", message: "env", details: { code } }),
      { status, headers: { "content-type": "application/json" } },
    );
  }

  it("recognises only the plugin refusals, without consuming the response", async () => {
    const response = refused("ENV_PLUGIN_UNAVAILABLE");
    expect(await readRecoverableHiddenEnvironmentCode(response)).toBe(
      "ENV_PLUGIN_UNAVAILABLE",
    );
    expect((await response.json()).details.code).toBe("ENV_PLUGIN_UNAVAILABLE");
    expect(
      await readRecoverableHiddenEnvironmentCode(
        refused("ENV_PLUGIN_COMPONENT_UNSUPPORTED"),
      ),
    ).toBe("ENV_PLUGIN_COMPONENT_UNSUPPORTED");
    expect(
      await readRecoverableHiddenEnvironmentCode(refused("ENV_HOST_MISSING")),
    ).toBeNull();
    expect(
      await readRecoverableHiddenEnvironmentCode(
        refused("ENV_PLUGIN_UNAVAILABLE", 400),
      ),
    ).toBeNull();
    expect(
      await readRecoverableHiddenEnvironmentCode(
        new Response("not json", { status: 409 }),
      ),
    ).toBeNull();
  });

  it("retargets only what the composition owns", () => {
    const body = JSON.stringify({
      selectedServerIds: ["mine"],
      executionTarget: { kind: "environment", environmentId: "old" },
      environmentOverrides: { serverIds: ["mine", "old_plugin"] },
      includeProjectSkills: true,
      chatSessionId: "c",
    });
    expect(
      JSON.parse(
        retargetHiddenEnvironmentBody(body, {
          environmentId: "new",
          pluginServerIds: ["new_plugin"],
        })!,
      ),
    ).toEqual({
      selectedServerIds: ["mine"],
      executionTarget: { kind: "environment", environmentId: "new" },
      environmentOverrides: { serverIds: ["mine", "new_plugin"] },
      includeProjectSkills: true,
      chatSessionId: "c",
    });
    expect(
      JSON.parse(
        retargetHiddenEnvironmentBody(body, {
          environmentId: null,
          hostId: "host_1",
        })!,
      ),
    ).toEqual({
      selectedServerIds: ["mine"],
      chatSessionId: "c",
      hostId: "host_1",
    });
    expect(
      retargetHiddenEnvironmentBody("{", { environmentId: null, hostId: "h" }),
    ).toBeNull();
  });

  it("restates a refusal plainly, keeping status and request id", async () => {
    const original = new Response("{}", {
      status: 409,
      headers: { "x-request-id": "req_9", "content-length": "2" },
    });
    const plain = plainHiddenEnvironmentFailure(original);
    expect(plain.status).toBe(409);
    expect(plain.headers.get("x-request-id")).toBe("req_9");
    expect(await plain.json()).toEqual({
      code: "CONFLICT",
      message: HIDDEN_ENVIRONMENT_RETRY_FAILED_MESSAGE,
    });
  });
});
