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
