import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  ADD_SERVER_NODE_ID,
  HOST_MATRIX_NODE_ID,
  SERVERS_HUB_NODE_ID,
  type HostMatrixNodeData,
} from "../../types";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

function buildVm(
  overrides: Partial<Parameters<typeof buildRedesignedHostCanvas>[0]> = {},
) {
  return buildRedesignedHostCanvas(
    {
      hostName: "Test host",
      draft: emptyHostConfigInputV2(),
      savedSnapshotId: "snap",
      isDirty: false,
      projectServers: [],
      ...overrides,
    },
    [],
  );
}

function matrixData(
  vm: ReturnType<typeof buildRedesignedHostCanvas>,
): HostMatrixNodeData {
  const node = vm.nodes.find((n) => n.id === HOST_MATRIX_NODE_ID);
  if (!node || node.type !== "redesignHostMatrix") {
    throw new Error("Matrix node missing");
  }
  return node.data;
}

describe("buildRedesignedHostCanvas", () => {
  it("emits a single host matrix node packing the full host surface", () => {
    const vm = buildVm({ hostName: "My Host" });
    const data = matrixData(vm);
    expect(data.kind).toBe("host-matrix");
    expect(data.hostName).toBe("My Host");
    expect(data.agent?.kind).toBe("agent-identity");
    expect(data.appsCaps).toHaveLength(6);
    expect(data.clientCaps).toHaveLength(6);
  });

  it("falls back to 'Untitled host' when name is whitespace", () => {
    const data = matrixData(buildVm({ hostName: "   " }));
    expect(data.hostName).toBe("Untitled host");
  });

  it("emits all client capability rows in stable order (base + extensions)", () => {
    const data = matrixData(buildVm());
    expect(data.clientCaps.map((c) => c.key)).toEqual([
      "roots",
      "sampling",
      "elicitation",
      "tasks",
      "experimental",
      "extensions",
    ]);
  });

  it("flags a client capability as on with sub-tags when the draft declares it", () => {
    const draft = emptyHostConfigInputV2();
    draft.clientCapabilities = {
      roots: { listChanged: true },
      elicitation: { form: {}, url: {} },
    };
    const data = matrixData(buildVm({ draft }));
    const roots = data.clientCaps.find((c) => c.key === "roots");
    const elicit = data.clientCaps.find((c) => c.key === "elicitation");
    const sampling = data.clientCaps.find((c) => c.key === "sampling");
    expect(roots?.on).toBe(true);
    expect(roots?.subs).toEqual(["listChanged"]);
    expect(elicit?.on).toBe(true);
    expect(elicit?.subs).toEqual(["form", "url"]);
    expect(sampling?.on).toBe(false);
  });

  it("flags extensions as on with sorted extension URIs in subs when declared", () => {
    const draft = emptyHostConfigInputV2();
    draft.clientCapabilities = {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
        "https://example.com/ext": {},
      },
    };
    const data = matrixData(buildVm({ draft }));
    const ext = data.clientCaps.find((c) => c.key === "extensions");
    expect(ext?.on).toBe(true);
    expect(ext?.subs).toEqual([
      "https://example.com/ext",
      "io.modelcontextprotocol/ui",
    ]);
  });

  it("always emits the capabilities and timeout cells in the protocol band", () => {
    const data = matrixData(buildVm());
    const keys = data.protocolBand.map((p) => p.leafKey);
    expect(keys).toContain("capabilities");
    expect(keys).toContain("timeout");
  });

  it("flags an apps cap as newly-on when the previous host did not advertise it", () => {
    const prev = emptyHostConfigInputV2({
      hostCapabilitiesOverride: { openLinks: {} },
    });
    const next = emptyHostConfigInputV2({
      hostCapabilitiesOverride: {
        openLinks: {},
        updateModelContext: { text: {} },
      },
    });
    const data = matrixData(
      buildVm({ draft: next, prev: { hostName: "Prev", draft: prev } }),
    );
    const updated = data.appsCaps.find((c) => c.capKey === "updateModelContext");
    expect(updated?.on).toBe(true);
    expect(updated?.isNewlyOn).toBe(true);
  });

  it("flags a client cap as newly-on when the previous host did not declare it", () => {
    const prev = emptyHostConfigInputV2();
    prev.clientCapabilities = {};
    const next = emptyHostConfigInputV2();
    next.clientCapabilities = { roots: { listChanged: true } };
    const data = matrixData(
      buildVm({ draft: next, prev: { hostName: "Prev", draft: prev } }),
    );
    const roots = data.clientCaps.find((c) => c.key === "roots");
    expect(roots?.isNewlyOn).toBe(true);
  });

  it("emits the servers hub + add-server pill even with no project servers", () => {
    const vm = buildVm();
    expect(vm.nodes.find((n) => n.id === SERVERS_HUB_NODE_ID)).toBeDefined();
    expect(vm.nodes.find((n) => n.id === ADD_SERVER_NODE_ID)).toBeDefined();
  });

  it("emits one server card per project server with a hub→card edge", () => {
    const vm = buildVm({
      projectServers: [
        { id: "s1", name: "Excalidraw", url: "https://example.com" },
        { id: "s2", name: "bench", url: "http://localhost:3000" },
      ],
    });
    expect(vm.nodes.find((n) => n.id === "server-card:s1")).toBeDefined();
    expect(vm.nodes.find((n) => n.id === "server-card:s2")).toBeDefined();
    expect(vm.edges.find((e) => e.id === "hub-to-server-s1")).toBeDefined();
    expect(vm.edges.find((e) => e.id === "hub-to-server-s2")).toBeDefined();
  });
});

describe("buildRedesignedHostCanvas — sandbox config rows", () => {
  it("emits only the permissions row when every other slice is at the safe default — no noise rows", () => {
    // mode='declared', empty restrictTo / cspDirectives / sandboxAttrs /
    // allowFeatures are all spec-aligned safe defaults. Surfacing them as
    // rows would just confirm "safe default in effect" on every host.
    // permissions stays because it's always informative (lists granted spec
    // keys, "—" when nothing's granted).
    const data = matrixData(buildVm());
    expect(data.sandbox.map((s) => s.subKey)).toEqual(["permissions"]);
  });

  it("emits mode + restrictTo + permissions in stable order when both deviate from defaults", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            mode: "relaxed",
            restrictTo: { connectDomains: ["https://api.openai.com"] },
          },
        },
      },
    };
    const data = matrixData(buildVm({ draft }));
    expect(data.sandbox.map((s) => s.subKey)).toEqual([
      "mode",
      "restrictTo",
      "permissions",
    ]);
  });

  it("omits the mode row entirely when mode is 'declared' (the spec-default trust-view behavior)", () => {
    const row = matrixData(buildVm()).sandbox.find((s) => s.subKey === "mode");
    expect(row).toBeUndefined();
  });

  it("tints mode='relaxed' as warn (opens the iframe up, not silent narrowing)", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: { sandbox: { csp: { mode: "relaxed" } } },
    };
    const mode = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "mode",
    );
    expect(mode?.summary).toBe("relaxed");
    expect(mode?.severity).toBe("warn");
  });

  it("emits a neutral-tinted mode row when mode is 'host-default' (deviation worth surfacing, but not danger)", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: { sandbox: { csp: { mode: "host-default" } } },
    };
    const mode = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "mode",
    );
    expect(mode?.summary).toBe("host-default");
    expect(mode?.severity).toBe("neutral");
  });

  it("tints restrictTo as DANGER when populated — the intersection trap that silently breaks widgets", () => {
    // Regression: this is exactly the Excalidraw-broke scenario. A
    // hardcoded restrictTo here turns into an empty intersection for any
    // widget reaching a domain outside the list (e.g. esm.sh), silently
    // producing connect-src 'none'. The danger tint is the at-a-glance
    // signal users need; downgrading this to "warn" would re-hide the
    // failure mode the matrix exists to surface.
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            mode: "declared",
            restrictTo: {
              connectDomains: ["https://api.openai.com"],
              resourceDomains: ["https://cdn.jsdelivr.net", "https://x.com"],
            },
          },
        },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "restrictTo",
    );
    expect(row?.severity).toBe("danger");
    expect(row?.summary).toBe("3 domains");
    expect(row?.qualifier).toBe("c:1 r:2 f:0 b:0");
  });

  it("surfaces non-empty restrictTo directives so the matrix shows the actual narrowed domains, not just counts", () => {
    // SEP-1865 lists the four allowlist directive families (connect, resource,
    // frame, baseUri); the matrix needs to render the actual entries so a user
    // debugging "why is my widget blocked" can see what was narrowed.
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            restrictTo: {
              connectDomains: ["https://api.openai.com"],
              resourceDomains: ["https://cdn.jsdelivr.net", "https://x.com"],
            },
          },
        },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "restrictTo",
    );
    expect(row?.directives).toEqual([
      {
        key: "connectDomains",
        label: "connect",
        domains: ["https://api.openai.com"],
      },
      {
        key: "resourceDomains",
        label: "resource",
        domains: ["https://cdn.jsdelivr.net", "https://x.com"],
      },
    ]);
  });

  it("omits the restrictTo row entirely when empty (the safe default)", () => {
    const row = matrixData(buildVm()).sandbox.find(
      (s) => s.subKey === "restrictTo",
    );
    expect(row).toBeUndefined();
  });

  it("summarizes permissions as the granted spec keys (no inspector-internal mode name leaks into the row)", () => {
    // SEP-1865 is allowlist-only — what matters to a reader is *which*
    // permissions are granted, not which inspector resolver mode produced
    // the grant. The `mode` enum (resource-declared / deny-all / custom)
    // is an MCPJam knob and would only confuse a developer reading the
    // matrix against the spec.
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          permissions: {
            mode: "custom",
            allow: { clipboardWrite: true, microphone: false },
          },
        },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "permissions",
    );
    // Only TRUE entries surface — false grants shouldn't look like grants.
    expect(row?.summary).toBe("clipboardWrite");
    expect(row?.qualifier).toBeNull();
  });

  it("renders empty-permissions row as '—' (rendered via semanticAbsence as 'none granted')", () => {
    const row = matrixData(buildVm()).sandbox.find(
      (s) => s.subKey === "permissions",
    );
    expect(row?.summary).toBe("—");
    expect(row?.qualifier).toBeNull();
  });

  it("omits the new inspector-only rows entirely when at the safe default", () => {
    // cspDirectives / sandboxAttrs / allowFeatures all follow the same
    // "skip at default" pattern as mode / restrictTo — surfacing them as
    // "—" rows would just confirm "safe default in effect" on every host.
    const data = matrixData(buildVm());
    for (const key of ["cspDirectives", "sandboxAttrs", "allowFeatures"]) {
      const row = data.sandbox.find((s) => s.subKey === key);
      expect(row).toBeUndefined();
    }
  });

  it("tints cspDirectives as DANGER when any value contains 'unsafe-eval'", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            cspDirectives: {
              "script-src": ["'unsafe-eval'", "'wasm-unsafe-eval'"],
            },
          },
        },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "cspDirectives",
    );
    expect(row?.severity).toBe("danger");
    expect(row?.summary).toBe("1 directive");
  });

  it("keeps cspDirectives NEUTRAL when only safe tokens are present", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            cspDirectives: {
              "img-src": ["blob:", "data:"],
              "connect-src": ["https://api.example.com"],
            },
          },
        },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "cspDirectives",
    );
    expect(row?.severity).toBe("neutral");
    expect(row?.summary).toBe("2 directives");
  });

  it("summarizes sandboxAttrs as a neutral list", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: { sandboxAttrs: ["allow-forms", "allow-modals"] },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "sandboxAttrs",
    );
    expect(row?.severity).toBe("neutral");
    expect(row?.summary).toBe("allow-forms, allow-modals");
  });

  it("summarizes allowFeatures as a neutral key:value list", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: { allowFeatures: { fullscreen: "*" } },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "allowFeatures",
    );
    expect(row?.severity).toBe("neutral");
    expect(row?.summary).toBe("fullscreen: *");
  });

  it("flags a sandbox row as changed when the previous host had different config", () => {
    const prev = emptyHostConfigInputV2();
    const next = emptyHostConfigInputV2();
    next.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            mode: "declared",
            restrictTo: { connectDomains: ["https://api.openai.com"] },
          },
        },
      },
    };
    const data = matrixData(
      buildVm({ draft: next, prev: { hostName: "Prev", draft: prev } }),
    );
    const restrictTo = data.sandbox.find((s) => s.subKey === "restrictTo");
    expect(restrictTo?.isChanged).toBe(true);
  });
});
