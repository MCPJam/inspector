import { memo, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { HostThemeMode } from "@/lib/client-styles";
import claudeLogo from "/claude_logo.png";
import claudeCodeLogo from "/claude_code_logo.png";
import openaiLogo from "/openai_logo.png";
import mistralLogo from "/mistral_logo.png";
import gooseLogoDark from "/goose_logo_dark.png";
import gooseLogoLight from "/goose_logo_light.png";
import cursorLogo from "/cursor_logo.png";
import codexLogo from "/codex-logo.svg";
import copilotLogo from "/copilot_logo.png";
import vscodeLogo from "/vscode_logo.svg";
import bedrockLogo from "/bedrock_logo.svg";
import n8nLogo from "/n8n_logo.svg";
import perplexityLogo from "/perplexity_logo.svg";
import clineLogoDark from "/cline_logo_dark.svg";
import clineLogoLight from "/cline_logo_light.svg";
import notionLogo from "/notion_logo.png";
import slackLogo from "/slack_logo.png";
import mcpjamLogo from "/mcp_jam_2row.png";
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
import { SandboxProxyIframeCard } from "./sandbox-config-grid";

function getClientLogo(
  clientInfoName: string | undefined,
  hostName: string | undefined,
  themeMode: HostThemeMode
): string | null {
  const haystack = `${clientInfoName ?? ""} ${hostName ?? ""}`.toLowerCase();
  if (haystack.includes("mcpjam") || haystack.includes("mcp-jam"))
    return mcpjamLogo;
  if (haystack.includes("claude-code") || haystack.includes("claude code"))
    return claudeCodeLogo;
  if (haystack.includes("claude")) return claudeLogo;
  if (haystack.includes("mistral") || haystack.includes("le chat"))
    return mistralLogo;
  // Goose's mark is a flat silhouette, so it needs to flip with the app
  // theme to stay visible: white goose on dark, black goose on light.
  if (haystack.includes("goose"))
    return themeMode === "dark" ? gooseLogoDark : gooseLogoLight;
  if (haystack.includes("cursor")) return cursorLogo;
  if (haystack.includes("codex")) return codexLogo;
  if (haystack.includes("copilot")) return copilotLogo;
  // VS Code's clientInfo.name is "Visual Studio Code"; the host name is
  // "VS Code". Match both spellings (the editor, not Cursor which forks it).
  if (
    haystack.includes("vscode") ||
    haystack.includes("vs code") ||
    haystack.includes("visual studio")
  )
    return vscodeLogo;
  // AWS Bedrock AgentCore: clientInfo.name "bedrock-agentcore", host
  // "AgentCore". Reuses the Bedrock mark (no dedicated AgentCore asset).
  if (haystack.includes("agentcore") || haystack.includes("bedrock"))
    return bedrockLogo;
  if (haystack.includes("n8n")) return n8nLogo;
  if (haystack.includes("perplexity")) return perplexityLogo;
  if (haystack.includes("cline"))
    return themeMode === "dark" ? clineLogoDark : clineLogoLight;
  if (haystack.includes("notion")) return notionLogo;
  if (haystack.includes("slack")) return slackLogo;
  if (
    haystack.includes("openai") ||
    haystack.includes("chatgpt") ||
    haystack.includes("gpt")
  )
    return openaiLogo;
  return null;
}

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
}: HostMatrixCardProps) {
  const connectedClientCaps = clientCaps.filter((row) => row.on);

  const timeoutLeaf = protocolBand.find((l) => l.leafKey === "timeout");
  const clientInfoLeaf = protocolBand.find((l) => l.leafKey === "clientInfo");
  const protocolVersionLeaf = protocolBand.find(
    (l) => l.leafKey === "protocolVersion"
  );

  return (
    <article className="host-paper-card w-full">
      <style>{PAPER_STYLES}</style>

      {/* ===== Host outer frame ===== */}
      <div className="hp-host">
        {/* Identity strip — HOST_GROUP_NODE_ID */}
        <ClickableRegion
          id={HOST_GROUP_NODE_ID}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          className="hp-identity"
        >
          {(() => {
            // Pass the full value — `getClientLogo` already lowercases
            // and substring-matches against the combined haystack, so any
            // pre-tokenization here just hides keywords that don't sit at
            // index 0 (e.g. "mcp-client-claude" → no logo with split[0]).
            const clientLogo = getClientLogo(
              clientInfoLeaf?.value,
              hostName,
              themeMode
            );
            return (
              <span
                className={cn("hp-glyph", clientLogo && "hp-glyph--logo")}
                aria-hidden
              >
                {clientLogo ? (
                  <img src={clientLogo} alt="" className="hp-glyph-img" />
                ) : (
                  (agent?.modelProvider?.charAt(0) ?? "?").toUpperCase()
                )}
              </span>
            );
          })()}
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
                      timeoutLeaf.isChanged && "host-matrix-changed"
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
                  row.isNewlyOn && "host-matrix-newly"
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
                      row.isNewlyOn && "host-matrix-newly"
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
                  prefix.length
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
              : "Inspector injects window.openai into widget HTML before sandboxing, so OpenAI Apps SDK widgets keep working on this host."
            : "Inspector does NOT inject window.openai for this host. SEP-1865-only — widgets that rely on the OpenAI Apps SDK compatibility layer will not run."
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
              } on top of the host preset (e.g. Copilot's M365-published subset). Click to view the matrix.`
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

/* ---------------- subcomponents ---------------- */

function ClickableRegion({
  id,
  selectedNodeId,
  onSelectNode,
  className,
  style,
  children,
}: {
  id: string;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelectNode(id);
      }}
      style={style}
      className={cn(className, selectedNodeId === id && "hp-region--selected")}
    >
      {children}
    </button>
  );
}

/* ---------------- inline styles ---------------- */
/**
 * Frame palette is sourced from the app's design-system tokens
 * (--card, --muted, --border, --foreground, --muted-foreground,
 * --success, --warning, --destructive). Light/dark switches via
 * those tokens at :root / .dark, so the card matches the rest of
 * the product without a separate dark block here.
 *
 * Depth between the three nested frames comes from tonal
 * variation alone: Host = card, Sandbox = muted wash, View =
 * card again (inset back to the surface tone). The result is a
 * clear "paper inside grey inside paper" hierarchy without any
 * bespoke hue.
 */
const PAPER_STYLES = `
.host-paper-card {
  --hp-ink: var(--foreground);
  --hp-muted: var(--muted-foreground);
  --hp-muted-dim: color-mix(in oklch, var(--muted-foreground) 65%, transparent);
  --hp-hairline: var(--border);
  --hp-paper-surface: var(--popover);
  --hp-region-hover: color-mix(in oklch, var(--foreground) 4%, transparent);
  --hp-region-selected: color-mix(in oklch, var(--foreground) 7%, transparent);

  --hp-host-bg: var(--popover);
  --hp-host-ring: var(--border);

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

  --hp-emerald: var(--diagram-server);
  --hp-amber: var(--warning);
  --hp-danger: var(--destructive);

  color: var(--hp-ink);
  font-size: 14px;
  line-height: 1.5;
  text-align: left;
}
.dark .host-paper-card {
  --hp-host-bg: #000;
}
.host-paper-card .hp-mono {
  font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 0.92em;
}

/* === Host outer frame === */
.host-paper-card .hp-host {
  background: var(--hp-host-bg);
  border: 1px solid var(--hp-host-ring);
  border-radius: 18px;
  padding: 26px 26px 24px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* === Identity strip === */
.host-paper-card .hp-identity {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 0 22px 0;
  border: 0;
  border-bottom: 1px dashed var(--hp-hairline);
  background: transparent;
  cursor: pointer;
  text-align: left;
  width: 100%;
  border-radius: 10px;
}
.host-paper-card .hp-identity:hover { background: var(--hp-region-hover); }
.host-paper-card .hp-glyph {
  position: relative;
  width: 44px; height: 44px;
  background: transparent;
  border: none;
  border-radius: 11px;
  display: grid; place-items: center;
  font-weight: 600;
  font-size: 18px;
  color: var(--hp-ink);
  letter-spacing: -0.02em;
  flex: none;
}
.host-paper-card .hp-glyph-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 8px;
}
.host-paper-card .hp-glyph-state {
  position: absolute;
  top: -3px; right: -3px;
  width: 10px; height: 10px;
  border-radius: 999px;
  background: var(--hp-emerald);
  border: 2px solid var(--hp-host-bg);
}
.host-paper-card .hp-identity-meta {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  line-height: 1.3;
}
.host-paper-card .hp-host-name {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--hp-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-paper-card .hp-host-sub {
  font-size: 12.5px;
  color: var(--hp-muted);
  margin-top: 1px;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.host-paper-card .hp-host-sub-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.host-paper-card .hp-host-sub-stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--hp-muted-dim);
  font-weight: 500;
}
.host-paper-card .hp-host-sub-stat-value {
  font-size: 12.5px;
  font-weight: 400;
  color: inherit;
}
.host-paper-card .hp-dot-sep { color: var(--hp-muted-dim); }

/* === Section (Client capabilities) === */
.host-paper-card .hp-section { display: flex; flex-direction: column; gap: 12px; }
.host-paper-card .hp-section-head {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
  width: 100%;
  color: inherit;
}
.host-paper-card .hp-section-title {
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--hp-ink);
}

/* === Capability chip row === */
.host-paper-card .hp-caps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.host-paper-card .hp-cap {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px 6px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  background: var(--hp-paper-surface);
  border: 1px solid var(--hp-host-ring);
  color: var(--hp-ink);
  cursor: pointer;
  transition: transform 120ms ease, background 120ms ease;
}
.host-paper-card .hp-cap:hover { transform: translateY(-1px); }
.host-paper-card .hp-cap--off {
  color: var(--hp-muted-dim);
  background: transparent;
  border-style: dashed;
  font-weight: 400;
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklch, var(--muted-foreground) 60%, transparent);
  text-decoration-thickness: 0.5px;
}
.host-paper-card .hp-cap-dot {
  width: 6px; height: 6px;
  border-radius: 999px;
  background: var(--hp-emerald);
  flex: none;
}
.host-paper-card .hp-cap--off .hp-cap-dot {
  background: transparent;
  border: 1px solid var(--hp-muted-dim);
}
.host-paper-card .hp-cap-name {
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 12px;
}
.host-paper-card .hp-cap-tag {
  font-size: 10.5px;
  color: var(--hp-muted);
  padding-left: 6px;
  margin-left: 1px;
  border-left: 1px solid var(--hp-hairline);
  font-weight: 400;
  font-family: ui-monospace, "JetBrains Mono", monospace;
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

/* Off / selected variants of the host-level capability chip, used by
   the new Host capabilities section (mirrors the spec's hostCapabilities
   blob). Same shape as the Client capabilities chips so the two rows
   read as a matched pair. */
.host-paper-card .hp-cap--off {
  background: transparent;
  color: var(--hp-muted-dim);
  border-style: dashed;
  font-weight: 400;
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklch, var(--muted-foreground) 60%, transparent);
  text-decoration-thickness: 0.5px;
}
.host-paper-card .hp-cap--off .hp-cap-dot {
  background: transparent;
  border: 1px solid var(--hp-muted-dim);
}
.host-paper-card .hp-cap--selected {
  border-color: var(--hp-ink);
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

/* === Region selection wash === */
.host-paper-card .hp-region--selected {
  background: var(--hp-region-selected) !important;
}

/* === Diff flash === */
@keyframes hostMatrixDiffFlashPaper {
  0% { background-color: color-mix(in oklch, var(--warning) 32%, transparent); }
  100% { background-color: transparent; }
}
.host-paper-card .host-matrix-changed {
  animation: hostMatrixDiffFlashPaper 1.8s ease-out;
}
.host-paper-card .host-matrix-newly {
  box-shadow: inset 2px 0 0 var(--warning);
  animation: hostMatrixDiffFlashPaper 1.8s ease-out;
}
`;
