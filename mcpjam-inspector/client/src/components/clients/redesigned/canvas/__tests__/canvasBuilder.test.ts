import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
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
    expect(data.clientCaps).toHaveLength(5);
    expect(data.hostContext?.leafKey).toBe("hostContext");
  });

  it("falls back to 'Untitled host' when name is whitespace", () => {
    const data = matrixData(buildVm({ hostName: "   " }));
    expect(data.hostName).toBe("Untitled host");
  });

  it("emits all five base-protocol client capabilities in stable order", () => {
    const data = matrixData(buildVm());
    expect(data.clientCaps.map((c) => c.key)).toEqual([
      "roots",
      "sampling",
      "elicitation",
      "tasks",
      "experimental",
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

  it("always emits the capabilities and timeout cells in the protocol band", () => {
    const data = matrixData(buildVm());
    const keys = data.protocolBand.map((p) => p.leafKey);
    expect(keys).toContain("capabilities");
    expect(keys).toContain("timeout");
  });

  it("reports the hostContext field count in the footer leaf", () => {
    const draft = emptyHostConfigInputV2();
    draft.hostContext = { theme: "dark", locale: "en-US", timeZone: "UTC" };
    const data = matrixData(buildVm({ draft }));
    expect(data.hostContext?.value).toContain("3");
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
  it("always emits 4 sandbox rows (mode, restrictTo, deny, permissions) in stable order", () => {
    const data = matrixData(buildVm());
    expect(data.sandbox.map((s) => s.subKey)).toEqual([
      "mode",
      "restrictTo",
      "deny",
      "permissions",
    ]);
  });

  it("defaults to mode='declared' (the resolver default) when csp is unspecified", () => {
    const data = matrixData(buildVm());
    const mode = data.sandbox.find((s) => s.subKey === "mode");
    expect(mode?.summary).toBe("declared");
    // qualifier surfaces "default" when the user hasn't set anything so it's
    // clear the row shows what the resolver will apply, not what's persisted.
    expect(mode?.qualifier).toBe("default");
    expect(mode?.severity).toBe("neutral");
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

  it("tints deny as WARN (explicit narrowing the user opted into, not silent)", () => {
    const draft = emptyHostConfigInputV2();
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: { deny: { connectDomains: ["https://evil.com"] } },
        },
      },
    };
    const row = matrixData(buildVm({ draft })).sandbox.find(
      (s) => s.subKey === "deny",
    );
    expect(row?.severity).toBe("warn");
    expect(row?.summary).toBe("1 domains");
  });

  it("summarizes permissions mode + granted names", () => {
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
    expect(row?.summary).toBe("custom");
    // only TRUE entries surface in the qualifier — false grants shouldn't
    // look like grants
    expect(row?.qualifier).toBe("clipboardWrite");
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
