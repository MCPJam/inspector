import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { HostThemeMode } from "@/lib/client-styles";
import { resolveHostLogo } from "@/lib/host-logo";
import {
  APPS_HUB_NODE_ID,
  HOST_GROUP_NODE_ID,
  PROTOCOL_HUB_NODE_ID,
  SANDBOX_HUB_NODE_ID,
  appsCapLeafNodeId,
  sandboxConfigLeafNodeId,
  type AgentIdentityNodeData,
  type AppsCapLeafNodeData,
  type ClientCapRow,
  type ProtocolLeafNodeData,
  type SandboxConfigNodeData,
  type SandboxConfigSubKey,
} from "../types";
import {
  ClickableRegion,
  PAPER_STYLES,
} from "@/components/canvas-kit/paper-card";
import { SandboxProxyIframeCard } from "./sandbox-config-grid";

/* ============================================================
   Host card. The card IS the architecture diagram — Host frame
   wraps Sandbox frame wraps View frame; capability data lives
   inside the layer it belongs to. Depth comes from tonal
   variation of the app's design-system tokens (card → muted →
   card), so the card reads as the same product as the Servers
   tab. Sub-region clicks dispatch the same node ids as before.
   ============================================================ */
export interface HostMatrixCardProps {
  hostName: string;
  agent: AgentIdentityNodeData | null;
  protocolBand: ProtocolLeafNodeData[];
  clientCaps: ClientCapRow[];
  appsCaps: AppsCapLeafNodeData[];
  sandbox: SandboxConfigNodeData[];
  /**
   * hostInfo advertised in ui/initialize per SEP-1865 §McpUiInitializeResult.
   * Rendered inside the View iframe frame as the empty state — it's exactly
   * what a view would receive on connect, so the frame stays meaningful when
   * no actual view is mounted.
   */
  hostInfo: { name: string; version: string } | null;
  appsExtensionAdvertised: boolean;
  /**
   * Resolved vendor compat-runtime shim state. `openaiApps: true` →
   * inspector injects `window.openai` into widget HTML; `false` → no
   * shim. `fromOverride: true` means injection differs from the host
   * style preset (drives the chip's optional subtitle). `hasMethodOverrides`
   * / `methodCount` / `methodTotal` summarize the per-method matrix for
   * the chip's optional "N/M methods" subtitle.
   */
  compatRuntime: {
    openaiApps: boolean;
    fromOverride: boolean;
    hasMethodOverrides: boolean;
    methodCount: number;
    methodTotal: number;
  };
  /**
   * SEP-1865 `app.*` spec-bridge override state. Independent from
   * `compatRuntime` — see HostRedesignFlowNode types for the contract.
   */
  mcpAppsBridge: {
    hasOverrides: boolean;
    overrideCount: number;
  };
  themeMode?: HostThemeMode;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  /** The Harness section, between the identity strip and Client capabilities. */
  harness?: ReactNode;
}

export const HostMatrixCard = memo(function HostMatrixCard({
  hostName,
  agent,
  protocolBand,
  clientCaps,
  appsCaps,
  sandbox,
  hostInfo,
  appsExtensionAdvertised,
  compatRuntime,
  mcpAppsBridge,
  themeMode = "light",
  selectedNodeId,
  onSelectNode,
  harness,
}: HostMatrixCardProps) {
  const connectedClientCaps = clientCaps.filter((row) => row.on);

  const timeoutLeaf = protocolBand.find((l) => l.leafKey === "timeout");
  const clientInfoLeaf = protocolBand.find((l) => l.leafKey === "clientInfo");
  const protocolVersionLeaf = protocolBand.find(
    (l) => l.leafKey === "protocolVersion",
  );

  return (
    <article className="host-paper-card w-full">
      <style>{`${PAPER_STYLES}${HOST_MATRIX_PAPER_STYLES}`}</style>

      {/* ===== Host outer frame ===== */}
      <div className="hp-host">
        {/* Identity strip — HOST_GROUP_NODE_ID */}
        <ClickableRegion
          id={HOST_GROUP_NODE_ID}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          className="hp-identity"
        >
          {/* The host style's own logo, as in the client list, so a new
              template needs no separate keyword map here. */}
          <span className="hp-glyph" aria-hidden>
            <img
              src={resolveHostLogo(
                { name: hostName, hostStyle: agent?.hostStyle },
                themeMode,
              )}
              alt=""
              className="hp-glyph-img"
            />
          </span>
          <span className="hp-identity-meta">
            <span className="hp-host-name" title={hostName}>
              {hostName}
            </span>
            <span
              className="hp-host-sub"
              title={
                [
                  agent?.modelLabel?.trim(),
                  clientInfoLeaf?.value,
                  timeoutLeaf
                    ? `Timeout ${timeoutLeaf.value}`
                    : protocolVersionLeaf?.value,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
            >
              {agent?.modelLabel ?? "No model selected"}
              {clientInfoLeaf ? (
                <>
                  <span className="hp-dot-sep" aria-hidden>
                    ·
                  </span>
                  <span className="hp-mono">{clientInfoLeaf.value}</span>
                </>
              ) : null}
              {timeoutLeaf ? (
                <>
                  <span className="hp-dot-sep" aria-hidden>
                    ·
                  </span>
                  <span
                    className={cn(
                      "hp-host-sub-stat",
                      timeoutLeaf.isChanged && "host-matrix-changed",
                    )}
                  >
                    <span className="hp-host-sub-stat-label">Timeout</span>
                    <span className="hp-host-sub-stat-value">
                      {timeoutLeaf.value}
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <span className="hp-dot-sep" aria-hidden>
                    ·
                  </span>
                  <span className="hp-host-sub-stat-value">
                    {protocolVersionLeaf?.value ?? "—"}
                  </span>
                </>
              )}
            </span>
          </span>
        </ClickableRegion>

        {harness}

        {/* Client capabilities — chip row at the Host layer */}
        <div className="hp-section">
          <button
            type="button"
            className="hp-section-head"
            onClick={(e) => {
              e.stopPropagation();
              onSelectNode(PROTOCOL_HUB_NODE_ID);
            }}
          >
            <span className="hp-section-title">Client capabilities</span>
          </button>
          <div className="hp-caps">
            {connectedClientCaps.length === 0 ? (
              <button
                type="button"
                className="hp-cap hp-cap--off"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectNode(PROTOCOL_HUB_NODE_ID);
                }}
              >
                <span className="hp-cap-dot" aria-hidden />
                <span className="hp-cap-name">none advertised</span>
              </button>
            ) : null}
            {connectedClientCaps.map((row) => (
              <button
                key={row.key}
                type="button"
                className={cn(
                  "hp-cap",
                  row.isChanged && !row.isNewlyOn && "host-matrix-changed",
                  row.isNewlyOn && "host-matrix-newly",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectNode(PROTOCOL_HUB_NODE_ID);
                }}
              >
                <span className="hp-cap-dot" aria-hidden />
                <span className="hp-cap-name">{row.key}</span>
                {row.subs.length > 0 ? (
                  <span className="hp-cap-tag">{row.subs.join(" · ")}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {/* Host capabilities — chip row at the Host layer. These are the
            host-side capabilities advertised in McpUiInitializeResult.
            hostCapabilities per SEP-1865; the view consumes them but the
            host produces them, so they live at the host level (mirroring
            the Client capabilities chip row above). */}
        {appsExtensionAdvertised ? (
          <div className="hp-section">
            <button
              type="button"
              className="hp-section-head"
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(APPS_HUB_NODE_ID);
              }}
            >
              <span className="hp-section-title">Host capabilities</span>
            </button>
            <div className="hp-caps">
              {appsCaps.map((row) => {
                const isSelected =
                  selectedNodeId === appsCapLeafNodeId(row.capKey);
                return (
                  <button
                    key={row.capKey}
                    type="button"
                    className={cn(
                      "hp-cap",
                      !row.on && "hp-cap--off",
                      isSelected && "hp-cap--selected",
                      row.isChanged && !row.isNewlyOn && "host-matrix-changed",
                      row.isNewlyOn && "host-matrix-newly",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectNode(appsCapLeafNodeId(row.capKey));
                    }}
                  >
                    <span className="hp-cap-dot" aria-hidden />
                    <span className="hp-cap-name">{row.label}</span>
                    {row.on && row.qualifier ? (
                      <span className="hp-cap-tag">{row.qualifier}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* ===== Sandbox nested frame =====
            Delegated to `SandboxProxyIframeCard` so the chat-thread
            Sandbox debug panel renders an identical card from the
            runtime resolver payload. */}
        {appsExtensionAdvertised ? (
          <SandboxProxyIframeCard
            rows={sandbox}
            hostInfo={hostInfo}
            onTitleClick={() => onSelectNode(SANDBOX_HUB_NODE_ID)}
            onViewTitleClick={() => onSelectNode(APPS_HUB_NODE_ID)}
            selectedSubKey={(() => {
              const prefix = "sandbox-cfg:";
              if (selectedNodeId && selectedNodeId.startsWith(prefix)) {
                return selectedNodeId.slice(
                  prefix.length,
                ) as SandboxConfigSubKey;
              }
              return null;
            })()}
            onRowSelect={(subKey) =>
              onSelectNode(sandboxConfigLeafNodeId(subKey))
            }
            viewIframeInjectedGlobals={
              <ViewIframeInjectedGlobals
                compatRuntime={compatRuntime}
                mcpAppsBridge={mcpAppsBridge}
                onClick={() => onSelectNode(APPS_HUB_NODE_ID)}
              />
            }
          />
        ) : null}
      </div>
    </article>
  );
});

/* Injected globals strip inside the View iframe frame.
 *
 * Two chips rendered side by side, representing the two distinct surfaces
 * the widget JS sees on `window` at runtime:
 *
 *   - `window.openai` — ChatGPT-only compatibility shim (NOT in SEP-1865).
 *     Inspector injects into widget HTML before sandboxing so widgets
 *     written against the OpenAI Apps SDK keep working. Toggled by
 *     `mcpProfile.apps.compatRuntime.openaiApps` + per-method overrides.
 *
 *   - `app.*` — SEP-1865 MCP Apps spec bridge. Always present (it's the
 *     primary protocol). Sparse per-dimension overrides via
 *     `mcpProfile.apps.mcpAppsOverrides` let users simulate a published
 *     host's subset (e.g. Microsoft 365 Copilot's M365 table).
 *
 * The two surfaces are INDEPENDENT — toggling one never affects the
 * other. They share this chip strip purely because spatially, both are
 * "things the widget's JS sees on window at runtime."
 *
 * Clicking either chip routes to the Apps Extension tab.
 */
function ViewIframeInjectedGlobals({
  compatRuntime,
  mcpAppsBridge,
  onClick,
}: {
  compatRuntime: {
    openaiApps: boolean;
    fromOverride: boolean;
    hasMethodOverrides: boolean;
    methodCount: number;
    methodTotal: number;
  };
  mcpAppsBridge: {
    hasOverrides: boolean;
    overrideCount: number;
  };
  onClick: () => void;
}) {
  // Tag subtitles only when state differs from the host style preset.
  // Default preset values need no qualifier — the green dot is enough.
  const openaiSubtitle = compatRuntime.hasMethodOverrides
    ? `${compatRuntime.methodCount}/${compatRuntime.methodTotal} methods`
    : compatRuntime.fromOverride
      ? "overridden"
      : null;
  const mcpAppsSubtitle = mcpAppsBridge.hasOverrides
    ? `${mcpAppsBridge.overrideCount} ${
        mcpAppsBridge.overrideCount === 1 ? "override" : "overrides"
      }`
    : null;
  return (
    <div className="hp-view-injected">
      <button
        type="button"
        className={cn("hp-cap", !compatRuntime.openaiApps && "hp-cap--off")}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        title={
          compatRuntime.openaiApps
            ? compatRuntime.hasMethodOverrides
              ? `Inspector injects window.openai with a custom per-method surface (${compatRuntime.methodCount}/${compatRuntime.methodTotal} methods active). Click to view the matrix.`
              : "Inspector injects window.openai into widget HTML before sandboxing, so OpenAI Apps SDK widgets keep working on this client."
            : "Inspector does NOT inject window.openai for this client. SEP-1865-only — widgets that rely on the OpenAI Apps SDK compatibility layer will not run."
        }
      >
        <span className="hp-cap-dot" aria-hidden />
        <span className="hp-cap-name">window.openai</span>
        {openaiSubtitle ? (
          <span className="hp-cap-tag">{openaiSubtitle}</span>
        ) : null}
      </button>
      <button
        type="button"
        className="hp-cap"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        title={
          mcpAppsBridge.hasOverrides
            ? `SEP-1865 app.* spec bridge with ${
                mcpAppsBridge.overrideCount
              } sparse ${
                mcpAppsBridge.overrideCount === 1 ? "override" : "overrides"
              } on top of the client preset (e.g. Copilot's M365-published subset). Click to view the matrix.`
            : "SEP-1865 app.* spec bridge — primary MCP Apps protocol surface, always present. Click to view the per-dimension matrix."
        }
      >
        <span className="hp-cap-dot" aria-hidden />
        <span className="hp-cap-name">MCP Apps</span>
        {mcpAppsSubtitle ? (
          <span className="hp-cap-tag">{mcpAppsSubtitle}</span>
        ) : null}
      </button>
    </div>
  );
}

/* ---------------- inline styles ---------------- */
/**
 * The host card's own layers on top of the shared paper card: the Sandbox
 * and View frame palettes (a muted wash and the card tone again, so the
 * frames read as paper inside grey inside paper), the View frame's injected
 * globals strip, and the sandbox directive cells.
 */
const HOST_MATRIX_PAPER_STYLES = `
.host-paper-card {
  --hp-sandbox-bg: color-mix(in oklch, var(--diagram-sandbox) 8%, var(--popover));
  --hp-sandbox-ring: color-mix(in oklch, var(--diagram-sandbox) 35%, var(--border));
  --hp-sandbox-ink: var(--foreground);
  --hp-sandbox-accent: var(--diagram-sandbox);
  --hp-sandbox-sub: var(--muted-foreground);
  --hp-sandbox-hairline: color-mix(in oklch, var(--diagram-sandbox) 20%, var(--border));
  --hp-sandbox-row-hover: color-mix(in oklch, var(--diagram-sandbox) 6%, transparent);
  --hp-sandbox-row-selected: color-mix(in oklch, var(--diagram-sandbox) 12%, transparent);

  --hp-view-bg: color-mix(in oklch, var(--diagram-view) 10%, var(--popover));
  --hp-view-ring: color-mix(in oklch, var(--diagram-view) 40%, var(--border));
  --hp-view-ink: var(--foreground);
  --hp-view-accent: var(--diagram-view);
  --hp-view-sub: var(--muted-foreground);
  --hp-view-cap-selected-bg: color-mix(in oklch, var(--diagram-view) 14%, transparent);
}

/* Sandbox + View frame chrome now lives in sandbox-config-grid.css,
   scoped under the .sandbox-proxy-iframe-card selector. The matrix
   mounts <SandboxProxyIframeCard /> directly so dropping these
   duplicates avoids drift between the two call sites (matrix and the
   chat-thread Sandbox debug panel). */

/* Injected-globals strip inside the View iframe frame — single chip
   showing what is pre-injected onto the widget's window object. */
.host-paper-card .hp-view-injected {
  display: flex;
  align-items: center;
  padding: 8px 4px 2px;
}

/* Sandbox config cell — wraps the row button so an optional directive
   list can render below it without breaking the 2-col grid. When the
   row has directives populated, the cell expands to full-width and the
   list of directive domains appears as a quiet sub-block. */
.host-paper-card .hp-sb-cell {
  display: contents;
}
.host-paper-card .hp-sb-cell--with-directives {
  display: block;
  grid-column: 1 / -1;
}
.host-paper-card .hp-sb-directives {
  list-style: none;
  margin: 4px 0 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in oklch, var(--diagram-sandbox) 6%, transparent);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.host-paper-card .hp-sb-directive {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  font-size: 11px;
  color: var(--hp-sandbox-ink);
}
.host-paper-card .hp-sb-directive-label {
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 10.5px;
  color: var(--hp-sandbox-sub);
  text-transform: lowercase;
}
.host-paper-card .hp-sb-directive-domains {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.host-paper-card .hp-sb-directive-domain {
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in oklch, var(--diagram-sandbox) 14%, transparent);
  border: 1px solid var(--hp-sandbox-hairline);
  color: var(--hp-sandbox-ink);
  word-break: break-all;
}
`;
