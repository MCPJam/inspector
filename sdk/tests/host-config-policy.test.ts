import {
  extractHostExecutionPolicy,
  buildHostIterationMetadata,
  buildHostSnapshotMetadata,
  type HostExecutionPolicy,
  type ToolExposureSignals,
} from "../src/host-config/internal";
import { Host } from "../src/host-config/host";

describe("extractHostExecutionPolicy", () => {
  it("returns safe defaults when hostConfig is null", () => {
    const policy = extractHostExecutionPolicy(null);
    expect(policy.requireToolApproval).toBe(false);
    expect(policy.respectToolVisibility).toBeUndefined();
    expect(policy.progressiveDiscoveryEnabled).toBe(false);
    expect(policy.modelVisibleMcpToolResults.directContent.image).toBe(true);
    expect(policy.modelVisibleMcpToolResults.embeddedResources.blob.image).toBe(
      true
    );
    expect(policy.modelVisibleMcpToolResults.linkedResources.blob.image).toBe(
      true
    );
    expect(policy.mcpToolResultImageRendering).toEqual({
      placement: "inline",
      directContent: { image: true },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: true } },
    });
    expect(policy.hostStyle).toBeUndefined();
    expect(policy.namedHostId).toBeUndefined();
  });

  it("extracts requireToolApproval from hostConfig", () => {
    const policy = extractHostExecutionPolicy({ requireToolApproval: true });
    expect(policy.requireToolApproval).toBe(true);
  });

  it("extracts respectToolVisibility: false (opt-out)", () => {
    const policy = extractHostExecutionPolicy({ respectToolVisibility: false });
    expect(policy.respectToolVisibility).toBe(false);
  });

  it("leaves respectToolVisibility undefined when not set (spec default)", () => {
    const policy = extractHostExecutionPolicy({});
    expect(policy.respectToolVisibility).toBeUndefined();
  });

  it("extracts progressive discovery when enabled flag is true", () => {
    const policy = extractHostExecutionPolicy({
      progressiveToolDiscovery: { enabled: true, threshold: 5 },
    });
    expect(policy.progressiveDiscoveryEnabled).toBe(true);
  });

  it("does not set progressive discovery when enabled is false", () => {
    const policy = extractHostExecutionPolicy({
      progressiveToolDiscovery: { enabled: false },
    });
    expect(policy.progressiveDiscoveryEnabled).toBe(false);
  });

  it("extracts progressive discovery from HostConfigV2 boolean shape", () => {
    const policy = extractHostExecutionPolicy({
      progressiveToolDiscovery: true,
    });
    expect(policy.progressiveDiscoveryEnabled).toBe(true);
  });

  it("does not set progressive discovery when boolean is false", () => {
    const policy = extractHostExecutionPolicy({
      progressiveToolDiscovery: false,
    });
    expect(policy.progressiveDiscoveryEnabled).toBe(false);
  });

  it("extracts hostStyle and namedHostId", () => {
    const policy = extractHostExecutionPolicy({ hostStyle: "cursor" }, "h_abc");
    expect(policy.hostStyle).toBe("cursor");
    expect(policy.namedHostId).toBe("h_abc");
  });

  it("enables model-visible MCP image tool results by default for all host styles", () => {
    for (const hostStyle of [
      "claude",
      "claude-code",
      "chatgpt",
      "mcpjam",
      "cursor",
      "some-custom-host",
    ]) {
      const policy = extractHostExecutionPolicy({ hostStyle });
      expect(policy.modelVisibleMcpToolResults.directContent.image).toBe(true);
      expect(
        policy.modelVisibleMcpToolResults.embeddedResources.blob.image
      ).toBe(true);
      expect(policy.modelVisibleMcpToolResults.linkedResources.blob.image).toBe(
        true
      );
    }
  });

  it("allows host config to override model-visible MCP image policies", () => {
    const policy = extractHostExecutionPolicy({
      hostStyle: "cursor",
      modelVisibleMcpToolResults: {
        directContent: { image: false },
        embeddedResources: { blob: { image: false } },
        linkedResources: { blob: { image: true } },
      },
    });
    expect(policy.modelVisibleMcpToolResults.directContent.image).toBe(false);
    expect(policy.modelVisibleMcpToolResults.embeddedResources.blob.image).toBe(
      false
    );
    expect(policy.modelVisibleMcpToolResults.linkedResources.blob.image).toBe(
      true
    );
  });

  it("extracts MCP tool-result image rendering with inline default", () => {
    expect(extractHostExecutionPolicy({}).mcpToolResultImageRendering).toEqual({
      placement: "inline",
      directContent: { image: true },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: true } },
    });
    expect(
      extractHostExecutionPolicy({
        mcpToolResultImageRendering: {
          placement: "collapsed",
          directContent: { image: false },
          embeddedResources: { blob: { image: true } },
          linkedResources: { blob: { image: false } },
        },
      }).mcpToolResultImageRendering
    ).toEqual({
      placement: "collapsed",
      directContent: { image: false },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: false } },
    });
    expect(
      extractHostExecutionPolicy({
        mcpToolResultImageRendering: "bad",
      }).mcpToolResultImageRendering
    ).toEqual({
      placement: "inline",
      directContent: { image: true },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: true } },
    });
  });
});

describe("buildHostIterationMetadata", () => {
  const basePolicy: HostExecutionPolicy = {
    requireToolApproval: false,
    respectToolVisibility: undefined,
    progressiveDiscoveryEnabled: false,
    modelVisibleMcpToolResults: {
      directContent: {
        text: true,
        image: false,
        audio: false,
      },
      embeddedResources: {
        text: false,
        blob: {
          enabled: true,
          image: false,
          audio: false,
          document: false,
          video: false,
          otherBinary: false,
        },
      },
      linkedResources: {
        text: false,
        blob: {
          enabled: true,
          image: false,
          audio: false,
          document: false,
          video: false,
          otherBinary: false,
        },
      },
    },
    mcpToolResultImageRendering: {
      placement: "inline",
      directContent: { image: true },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: true } },
    },
    hostStyle: undefined,
    namedHostId: undefined,
  };

  const baseSignals: ToolExposureSignals = {
    toolsTotalBefore: 10,
    toolsExposed: 10,
    toolsDroppedVisibility: 0,
  };

  it("always stamps tools_total_before and tools_exposed", () => {
    const meta = buildHostIterationMetadata(basePolicy, baseSignals, 0, false);
    expect(meta.tools_total_before).toBe(10);
    expect(meta.tools_exposed).toBe(10);
  });

  it("stamps tools_dropped_visibility only when > 0", () => {
    const signals: ToolExposureSignals = {
      toolsTotalBefore: 10,
      toolsExposed: 8,
      toolsDroppedVisibility: 2,
    };
    const meta = buildHostIterationMetadata(basePolicy, signals, 0, false);
    expect(meta.tools_dropped_visibility).toBe(2);
  });

  it("does not stamp tools_dropped_visibility when 0", () => {
    const meta = buildHostIterationMetadata(basePolicy, baseSignals, 0, false);
    expect(meta.tools_dropped_visibility).toBeUndefined();
  });

  it("stamps approvals_would_require when requireToolApproval and count > 0", () => {
    const policy: HostExecutionPolicy = {
      ...basePolicy,
      requireToolApproval: true,
    };
    const meta = buildHostIterationMetadata(policy, baseSignals, 3, false);
    expect(meta.approvals_would_require).toBe(3);
  });

  it("does not stamp approvals_would_require when requireToolApproval is false", () => {
    const meta = buildHostIterationMetadata(basePolicy, baseSignals, 3, false);
    expect(meta.approvals_would_require).toBeUndefined();
  });

  it("stamps progressive_discovery_enabled when true", () => {
    const policy: HostExecutionPolicy = {
      ...basePolicy,
      progressiveDiscoveryEnabled: true,
    };
    const meta = buildHostIterationMetadata(policy, baseSignals, 0, false);
    expect(meta.progressive_discovery_enabled).toBe(true);
  });

  it("stamps MCP image policy metadata when true", () => {
    const policy: HostExecutionPolicy = {
      ...basePolicy,
      modelVisibleMcpToolResults: {
        ...basePolicy.modelVisibleMcpToolResults,
        directContent: {
          ...basePolicy.modelVisibleMcpToolResults.directContent,
          image: true,
        },
        embeddedResources: {
          ...basePolicy.modelVisibleMcpToolResults.embeddedResources,
          blob: {
            ...basePolicy.modelVisibleMcpToolResults.embeddedResources.blob,
            image: true,
          },
        },
        linkedResources: {
          ...basePolicy.modelVisibleMcpToolResults.linkedResources,
          blob: {
            ...basePolicy.modelVisibleMcpToolResults.linkedResources.blob,
            image: true,
          },
        },
      },
    };
    const meta = buildHostIterationMetadata(policy, baseSignals, 0, false);
    expect(meta.model_visible_mcp_direct_content_image).toBe(true);
    expect(meta.model_visible_mcp_embedded_resource_blob_image).toBe(true);
    expect(meta.model_visible_mcp_linked_resource_blob_image).toBe(true);
  });

  it("stamps non-default MCP tool-result image rendering metadata", () => {
    const policy: HostExecutionPolicy = {
      ...basePolicy,
      mcpToolResultImageRendering: {
        ...basePolicy.mcpToolResultImageRendering,
        placement: "collapsed",
      },
    };
    const meta = buildHostIterationMetadata(policy, baseSignals, 0, false);
    expect(meta.mcp_tool_result_image_rendering).toBe("collapsed");
  });

  it("stamps openai_compat_injected when true", () => {
    const meta = buildHostIterationMetadata(basePolicy, baseSignals, 0, true);
    expect(meta.openai_compat_injected).toBe(true);
  });

  it("stamps host_id and host_style when present", () => {
    const policy: HostExecutionPolicy = {
      ...basePolicy,
      namedHostId: "h_claude",
      hostStyle: "claude",
    };
    const meta = buildHostIterationMetadata(policy, baseSignals, 0, false);
    expect(meta.host_id).toBe("h_claude");
    expect(meta.host_style).toBe("claude");
  });
});

// Regression: `extractHostExecutionPolicy` historically only read the
// canonical `hostStyle` field. `HostRunner` now feeds it `Host.toJSON()`
// snapshots whose top-level field is `style`. Both shapes must work or
// SDK eval reports lose `host_style` stamping and the OpenAI-compat
// decision misfires for `style: "mcpjam"`-style hosts.
describe("HostJson shape (public API) compatibility", () => {
  it("reads `style` from a HostJson snapshot", () => {
    const policy = extractHostExecutionPolicy({ style: "mcpjam" });
    expect(policy.hostStyle).toBe("mcpjam");
  });

  it("works with a real Host.toJSON() snapshot end-to-end", () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
    }).requireServer("everything");
    const snapshot = host.toJSON();

    const policy = extractHostExecutionPolicy(
      snapshot as unknown as Record<string, unknown>
    );
    expect(policy.hostStyle).toBe("claude");
  });

  it("prefers canonical `hostStyle` when both fields are present", () => {
    const policy = extractHostExecutionPolicy({
      hostStyle: "claude",
      style: "mcpjam",
    });
    expect(policy.hostStyle).toBe("claude");
  });
});

describe("buildHostSnapshotMetadata", () => {
  it("stamps host style and model-visible MCP image policy from snapshot", () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-3",
    }).toJSON();
    const meta = buildHostSnapshotMetadata(
      host as unknown as Record<string, unknown>
    );
    // `claude` has no progressive discovery / named host id, but it does
    // carry a host style and default image-result policy.
    expect(meta.host_style).toBe("claude");
    expect(meta.model_visible_mcp_direct_content_image).toBe(true);
    expect(meta.model_visible_mcp_embedded_resource_blob_image).toBe(true);
    expect(meta.model_visible_mcp_linked_resource_blob_image).toBe(true);
    expect(meta.host_id).toBeUndefined();
    expect(meta.progressive_discovery_enabled).toBeUndefined();
  });

  it("stamps progressive_discovery_enabled from snapshot", () => {
    const host = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
      progressiveToolDiscovery: true,
    }).toJSON();
    const meta = buildHostSnapshotMetadata(
      host as unknown as Record<string, unknown>
    );
    expect(meta.progressive_discovery_enabled).toBe(true);
    expect(meta.host_style).toBe("mcpjam");
  });

  it("returns {} for null input (no executor host snapshot)", () => {
    expect(buildHostSnapshotMetadata(null)).toEqual({});
  });
});
