import type { ReactNode } from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "@mcpjam/sdk/browser";
import {
  ActiveHostCapsResolverScope,
  useActiveHostCapsResolver,
  useActiveHostWidgetGate,
} from "../active-host-client-capabilities-context";
import { AppStateProvider } from "@/state/app-state-context";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

/**
 * End-to-end resolver tests: render the scope inside a minimal
 * AppStateProvider with a `servers` map, then read `resolveCaps(serverId)`
 * via a probe component. Verifies the gate uses the same effective-caps
 * function as `initialize`, so per-server overrides land in the renderer.
 */

function ProbeOutput({ serverId }: { serverId?: string }) {
  const resolveCaps = useActiveHostCapsResolver();
  const caps = resolveCaps(serverId);
  return (
    <span data-testid="caps">{caps ? JSON.stringify(caps) : "undefined"}</span>
  );
}

function GateOutput({ serverId }: { serverId?: string }) {
  const hostSupportsWidget = useActiveHostWidgetGate();
  return <span data-testid="gate">{String(hostSupportsWidget(serverId))}</span>;
}

function mountWithState(args: {
  activeHost?: HostConfigDtoV2 | null;
  hostStyle: string;
  servers: Record<string, { name: string; config: Record<string, unknown> }>;
  serverId?: string;
  probe?: ReactNode;
}) {
  const minimalAppState = {
    servers: args.servers as never,
    selectedServer: undefined,
    selectedMultipleServers: [],
  } as unknown as Parameters<typeof AppStateProvider>[0]["appState"];

  return render(
    <AppStateProvider appState={minimalAppState}>
      <ActiveHostCapsResolverScope
        activeHost={args.activeHost ?? null}
        hostStyle={args.hostStyle}
      >
        {args.probe ?? <ProbeOutput serverId={args.serverId} />}
      </ActiveHostCapsResolverScope>
    </AppStateProvider>
  );
}

const HOST_WITH_UI: Pick<HostConfigDtoV2, "clientCapabilities"> = {
  clientCapabilities: {
    extensions: {
      [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE] },
    },
  },
};

const HOST_NO_UI: Pick<HostConfigDtoV2, "clientCapabilities"> = {
  clientCapabilities: { elicitation: {} },
};

describe("ActiveHostCapsResolverScope (resolver)", () => {
  it("uses host-level caps when no per-server override exists", () => {
    const { getByTestId } = mountWithState({
      activeHost: HOST_WITH_UI as HostConfigDtoV2,
      hostStyle: "chatgpt",
      servers: { srv: { name: "srv", config: {} } },
      serverId: "srv",
    });
    const caps = JSON.parse(getByTestId("caps").textContent ?? "{}");
    expect(caps.extensions?.[MCP_UI_EXTENSION_ID]?.mimeTypes).toContain(
      MCP_UI_RESOURCE_MIME_TYPE
    );
  });

  it("per-server clientCapabilities override strips UI on a UI-capable host", () => {
    const { getByTestId } = mountWithState({
      activeHost: HOST_WITH_UI as HostConfigDtoV2,
      hostStyle: "chatgpt",
      servers: {
        // Server explicitly advertises no extensions — should win over host.
        srv: { name: "srv", config: { clientCapabilities: {} } },
      },
      serverId: "srv",
    });
    const caps = JSON.parse(getByTestId("caps").textContent ?? "{}");
    expect(caps.extensions).toBeUndefined();
  });

  it("per-server clientCapabilities override re-adds UI on a no-UI host (Codex)", () => {
    // Inspector contract: server-level override beats host identity. A
    // user modeling "I'm Codex but this one server pretends I can render"
    // gets widgets for that server's tools.
    const { getByTestId } = mountWithState({
      activeHost: HOST_NO_UI as HostConfigDtoV2,
      hostStyle: "codex",
      servers: {
        srv: {
          name: "srv",
          config: {
            clientCapabilities: {
              extensions: {
                [MCP_UI_EXTENSION_ID]: {
                  mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
                },
              },
            },
          },
        },
      },
      serverId: "srv",
    });
    const caps = JSON.parse(getByTestId("caps").textContent ?? "{}");
    expect(caps.extensions?.[MCP_UI_EXTENSION_ID]?.mimeTypes).toContain(
      MCP_UI_RESOURCE_MIME_TYPE
    );
  });

  it("per-server `capabilities` (additive) merges with host caps", () => {
    // `serverConfig.capabilities` is the additive legacy field.
    // `resolveEffectiveClientCapabilities` merges it with host caps when
    // there is no `clientCapabilities` override. The merged blob should
    // include both the host's UI extension AND the server's addition.
    const { getByTestId } = mountWithState({
      activeHost: HOST_WITH_UI as HostConfigDtoV2,
      hostStyle: "chatgpt",
      servers: {
        srv: {
          name: "srv",
          config: { capabilities: { sampling: {} } },
        },
      },
      serverId: "srv",
    });
    const caps = JSON.parse(getByTestId("caps").textContent ?? "{}");
    expect(caps.extensions?.[MCP_UI_EXTENSION_ID]?.mimeTypes).toContain(
      MCP_UI_RESOURCE_MIME_TYPE
    );
    expect(caps.sampling).toBeDefined();
  });

  it("falls back to host caps when serverId is unknown to appState", () => {
    const { getByTestId } = mountWithState({
      activeHost: HOST_WITH_UI as HostConfigDtoV2,
      hostStyle: "chatgpt",
      servers: {},
      serverId: "ghost-server",
    });
    const caps = JSON.parse(getByTestId("caps").textContent ?? "{}");
    expect(caps.extensions?.[MCP_UI_EXTENSION_ID]?.mimeTypes).toContain(
      MCP_UI_RESOURCE_MIME_TYPE
    );
  });

  it("synthesizes host caps from the template seed when activeHost is null (hosted scenario case)", () => {
    // Hosted scenario bootstrap payload doesn't carry clientCapabilities
    // yet (follow-up). Until then, the scope synthesizes them from the
    // host style. Codex now advertises MCP Apps, including the legacy
    // ChatGPT MIME type alongside the spec one.
    const { getByTestId } = mountWithState({
      activeHost: null,
      hostStyle: "codex",
      servers: { srv: { name: "srv", config: {} } },
      serverId: "srv",
    });
    const caps = JSON.parse(getByTestId("caps").textContent ?? "{}");
    expect(caps.extensions?.[MCP_UI_EXTENSION_ID]?.mimeTypes).toEqual([
      MCP_UI_RESOURCE_MIME_TYPE,
      "text/html+skybridge",
    ]);
  });
});

describe("useActiveHostWidgetGate", () => {
  const servers = { srv: { name: "srv", config: {} } };

  it("renders for a host that renders without declaring the extension", () => {
    const { getByTestId } = mountWithState({
      activeHost: {
        clientCapabilities: {},
        mcpProfile: { profileVersion: 1, appsViewRendering: "always" },
      } as HostConfigDtoV2,
      hostStyle: "gemini",
      servers,
      probe: <GateOutput serverId="srv" />,
    });
    expect(getByTestId("gate").textContent).toBe("true");
  });

  it("does not render when nothing is declared and the host requires it", () => {
    const { getByTestId } = mountWithState({
      activeHost: { clientCapabilities: {} } as HostConfigDtoV2,
      hostStyle: "gemini",
      servers,
      probe: <GateOutput serverId="srv" />,
    });
    expect(getByTestId("gate").textContent).toBe("false");
  });

  it("takes the declaration and the setting from the same template when no host is in scope", () => {
    // Gemini's template sends no extension, so a server that checks it
    // sees nothing to link UI for, yet its views still render here.
    const { getByTestId } = mountWithState({
      activeHost: null,
      hostStyle: "gemini",
      servers,
      probe: (
        <>
          <ProbeOutput serverId="srv" />
          <GateOutput serverId="srv" />
        </>
      ),
    });
    expect(JSON.parse(getByTestId("caps").textContent ?? "null")).toEqual({});
    expect(getByTestId("gate").textContent).toBe("true");
  });
});
