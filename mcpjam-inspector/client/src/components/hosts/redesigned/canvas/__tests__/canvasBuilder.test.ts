import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
import {
  AGENT_IDENTITY_NODE_ID,
  APPS_HUB_NODE_ID,
  HOST_GROUP_NODE_ID,
  PROTOCOL_HUB_NODE_ID,
  appsCapLeafNodeId,
  protocolLeafNodeId,
} from "../../types";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

describe("buildRedesignedHostCanvas", () => {
  it("stores only hostName on host-group canvas node data", () => {
    const draft = emptyHostConfigInputV2();
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "My Host",
        draft,
        savedSnapshotId: "snap",
        isDirty: true,
        projectServers: [],
      },
      [],
    );
    const groupNode = viewModel.nodes.find((n) => n.id === HOST_GROUP_NODE_ID);
    expect(groupNode?.type).toBe("redesignHostGroup");
    expect(groupNode?.data).toEqual({
      kind: "host-group",
      hostName: "My Host",
    });
  });

  it("emits agent identity, protocol hub, and apps hub child nodes", () => {
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Host",
        draft: emptyHostConfigInputV2(),
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );

    expect(
      viewModel.nodes.find((n) => n.id === AGENT_IDENTITY_NODE_ID)?.type,
    ).toBe("redesignAgentIdentity");
    expect(
      viewModel.nodes.find((n) => n.id === PROTOCOL_HUB_NODE_ID)?.type,
    ).toBe("redesignSectionHub");
    expect(viewModel.nodes.find((n) => n.id === APPS_HUB_NODE_ID)?.type).toBe(
      "redesignSectionHub",
    );
  });

  it("emits the full 6-cap apps leaf set with stable ids in canonical order", () => {
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Host",
        draft: emptyHostConfigInputV2(),
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );

    const expectedCaps = [
      "openLinks",
      "serverTools",
      "serverResources",
      "logging",
      "updateModelContext",
      "message",
    ] as const;
    for (const cap of expectedCaps) {
      const node = viewModel.nodes.find((n) => n.id === appsCapLeafNodeId(cap));
      expect(node, `expected cap leaf for ${cap}`).toBeDefined();
      expect(node?.type).toBe("redesignAppsCapLeaf");
    }
  });

  it("omits optional protocol leaves when not overridden", () => {
    // The default config has no mcpProfile + no custom headers, so
    // clientInfo / protocolVersion / capabilities / headers should NOT
    // emit leaves. hostContext + timeout always emit so they stay
    // comparable across hosts.
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Host",
        draft: emptyHostConfigInputV2(),
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );
    expect(
      viewModel.nodes.find((n) => n.id === protocolLeafNodeId("clientInfo")),
    ).toBeUndefined();
    expect(
      viewModel.nodes.find(
        (n) => n.id === protocolLeafNodeId("protocolVersion"),
      ),
    ).toBeUndefined();
    expect(
      viewModel.nodes.find((n) => n.id === protocolLeafNodeId("headers")),
    ).toBeUndefined();
    expect(
      viewModel.nodes.find((n) => n.id === protocolLeafNodeId("hostContext")),
    ).toBeDefined();
    expect(
      viewModel.nodes.find((n) => n.id === protocolLeafNodeId("timeout")),
    ).toBeDefined();
  });

  it("emits clientInfo and protocolVersion leaves when mcpProfile pins them", () => {
    const draft = emptyHostConfigInputV2({
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          clientInfo: { name: "cursor-vscode", version: "3.4.17" },
          supportedProtocolVersions: ["2026-01-26"],
        },
      },
    });
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Cursor",
        draft,
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );
    const clientInfo = viewModel.nodes.find(
      (n) => n.id === protocolLeafNodeId("clientInfo"),
    );
    const protocolVersion = viewModel.nodes.find(
      (n) => n.id === protocolLeafNodeId("protocolVersion"),
    );
    expect(clientInfo).toBeDefined();
    expect(protocolVersion).toBeDefined();
    expect((clientInfo?.data as { value: string })?.value).toBe(
      "cursor-vscode 3.4.17",
    );
    expect((protocolVersion?.data as { value: string })?.value).toBe(
      "2026-01-26",
    );
  });

  it("marks an apps cap as off when the resolved blob omits it", () => {
    // Cursor's probe-captured override omits updateModelContext and
    // message. The leaves still render — on=false — so the *absence*
    // of a cap is visually load-bearing.
    const draft = emptyHostConfigInputV2({
      hostCapabilitiesOverride: {
        openLinks: {},
        serverTools: { listChanged: false },
        serverResources: { listChanged: false },
        logging: {},
      },
    });
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Cursor",
        draft,
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );
    const updateCap = viewModel.nodes.find(
      (n) => n.id === appsCapLeafNodeId("updateModelContext"),
    );
    const messageCap = viewModel.nodes.find(
      (n) => n.id === appsCapLeafNodeId("message"),
    );
    expect((updateCap?.data as { on: boolean })?.on).toBe(false);
    expect((messageCap?.data as { on: boolean })?.on).toBe(false);

    const toolsCap = viewModel.nodes.find(
      (n) => n.id === appsCapLeafNodeId("serverTools"),
    );
    expect((toolsCap?.data as { on: boolean })?.on).toBe(true);
    expect(
      (toolsCap?.data as { qualifier: string | null })?.qualifier,
    ).toBe("lc:false");
  });

  it("flags leaves whose value differs from the previous host as isChanged", () => {
    // Switching from a Claude-like draft (no protocol pin, default
    // timeout) to a Cursor-like draft (pinned + 60s timeout) marks the
    // new leaves as changed against the prev draft.
    const prev = emptyHostConfigInputV2();
    const next = emptyHostConfigInputV2({
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          clientInfo: { name: "cursor-vscode", version: "3.4.17" },
          supportedProtocolVersions: ["2026-01-26"],
        },
      },
      connectionDefaults: { headers: {}, requestTimeout: 60000 },
    });
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Cursor",
        draft: next,
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
        prev: { hostName: "Claude", draft: prev },
      },
      [],
    );
    const timeoutLeaf = viewModel.nodes.find(
      (n) => n.id === protocolLeafNodeId("timeout"),
    );
    expect((timeoutLeaf?.data as { isChanged: boolean })?.isChanged).toBe(true);
  });

  it("flags apps cap leaves as isNewlyOn when prev was off and current is on", () => {
    const prev = emptyHostConfigInputV2({
      hostCapabilitiesOverride: { openLinks: {} },
    });
    const next = emptyHostConfigInputV2({
      hostCapabilitiesOverride: {
        openLinks: {},
        message: { text: {} },
      },
    });
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "ChatGPT",
        draft: next,
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
        prev: { hostName: "Cursor", draft: prev },
      },
      [],
    );
    const messageCap = viewModel.nodes.find(
      (n) => n.id === appsCapLeafNodeId("message"),
    );
    expect(
      (messageCap?.data as { isNewlyOn: boolean })?.isNewlyOn,
    ).toBe(true);
    expect((messageCap?.data as { on: boolean })?.on).toBe(true);
  });
});
