import { memo, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import cursorLogo from "/cursor_logo.png";
import codexLogo from "/codex-logo.svg";
import copilotLogo from "/copilot_logo.png";
import mcpjamLogo from "/mcp_jam_2row.png";
import {
  AGENT_IDENTITY_NODE_ID,
  APPS_HUB_NODE_ID,
  HOST_GROUP_NODE_ID,
  PROTOCOL_HUB_NODE_ID,
  SANDBOX_HUB_NODE_ID,
  appsCapLeafNodeId,
  protocolLeafNodeId,
  sandboxConfigLeafNodeId,
  type AgentIdentityNodeData,
  type AppsCapLeafNodeData,
  type ClientCapRow,
  type ProtocolLeafNodeData,
  type SandboxConfigNodeData,
} from "../types";

function getClientLogo(
  clientInfoName: string | undefined,
  hostName: string | undefined,
): string | null {
  const haystack = `${clientInfoName ?? ""} ${hostName ?? ""}`.toLowerCase();
  if (haystack.includes("mcpjam") || haystack.includes("mcp-jam")) return mcpjamLogo;
  if (haystack.includes("claude")) return claudeLogo;
  if (haystack.includes("cursor")) return cursorLogo;
  if (haystack.includes("codex")) return codexLogo;
  if (haystack.includes("copilot")) return copilotLogo;
  if (haystack.includes("openai") || haystack.includes("chatgpt") || haystack.includes("gpt"))
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
  appsExtensionAdvertised: boolean;
  hostContext: ProtocolLeafNodeData | null;
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
  appsExtensionAdvertised,
  hostContext,
  selectedNodeId,
  onSelectNode,
}: HostMatrixCardProps) {
  const clientOn = clientCaps.filter((c) => c.on).length;
  const appsOn = appsCaps.filter((c) => c.on).length;

  const timeoutLeaf = protocolBand.find((l) => l.leafKey === "timeout");
  const clientInfoLeaf = protocolBand.find((l) => l.leafKey === "clientInfo");
  const protocolVersionLeaf = protocolBand.find(
    (l) => l.leafKey === "protocolVersion",
  );
  const extensionsLeaf = protocolBand.find((l) => l.leafKey === "capabilities");

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
            const clientLogo = getClientLogo(clientInfoLeaf?.value, hostName);
            return (
              <span
                className={cn("hp-glyph", clientLogo && "hp-glyph--logo")}
                aria-hidden
              >
                {clientLogo ? (
                  <img
                    src={clientLogo}
                    alt=""
                    className="hp-glyph-img"
                  />
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
            <span className="hp-host-sub" title={agent?.modelLabel ?? ""}>
              {agent?.modelLabel ?? "No model selected"}
              {clientInfoLeaf ? (
                <>
                  <span className="hp-dot-sep" aria-hidden>
                    ·
                  </span>
                  <span className="hp-mono">{clientInfoLeaf.value}</span>
                </>
              ) : null}
            </span>
          </span>
        </ClickableRegion>

        {/* Agent stats — AGENT_IDENTITY_NODE_ID */}
        <ClickableRegion
          id={AGENT_IDENTITY_NODE_ID}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          className="hp-agents"
        >
          <PaperStat
            label="Temp"
            value={agent?.temperature.toFixed(2) ?? "—"}
            changed={agent?.changedFields.includes("temperature")}
            mono
          />
          <PaperStat
            label="Style"
            value={agent?.hostStyleLabel ?? "—"}
            changed={agent?.changedFields.includes("hostStyle")}
          />
          <PaperStat
            label="Approve"
            value={agent ? (agent.toolApproval ? "on" : "off") : "—"}
            changed={agent?.changedFields.includes("toolApproval")}
            muted={agent ? !agent.toolApproval : false}
          />
          <PaperStat
            label="Prompt"
            value={agent ? (agent.systemPromptEmpty ? "∅ empty" : "set") : "—"}
            changed={agent?.changedFields.includes("systemPrompt")}
            muted={agent?.systemPromptEmpty}
          />
          {timeoutLeaf ? (
            <PaperStat
              label="Timeout"
              value={timeoutLeaf.value}
              changed={timeoutLeaf.isChanged}
              mono
            />
          ) : (
            <PaperStat label="Protocol" value={protocolVersionLeaf?.value ?? "—"} mono />
          )}
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
            <span className="hp-section-count">
              <b>{clientOn}</b> of 5 advertised
              <span className="hp-section-meta"> · base protocol</span>
            </span>
          </button>
          <div className="hp-caps">
            {clientCaps.map((row) => (
              <button
                key={row.key}
                type="button"
                className={cn(
                  "hp-cap",
                  !row.on && "hp-cap--off",
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

        {/* ===== Sandbox nested frame ===== */}
        {appsExtensionAdvertised ? (
          <div className="hp-sandbox">
            <button
              type="button"
              className="hp-frame-head"
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(SANDBOX_HUB_NODE_ID);
              }}
            >
              <span className="hp-sandbox-title">
                Sandbox proxy iframe
                <span className="hp-policy-tag">host policy</span>
              </span>
              <span className="hp-sandbox-sub">
                Different origin · enforces CSP for nested Views
              </span>
            </button>

            <div className="hp-sb-grid">
              {sandbox.map((row) => (
                <SandboxConfigCell
                  key={row.subKey}
                  row={row}
                  selected={
                    selectedNodeId === sandboxConfigLeafNodeId(row.subKey)
                  }
                  onClick={() =>
                    onSelectNode(sandboxConfigLeafNodeId(row.subKey))
                  }
                />
              ))}
            </div>

            {/* ===== View nested-nested frame ===== */}
            <div className="hp-view">
              <button
                type="button"
                className="hp-frame-head"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectNode(APPS_HUB_NODE_ID);
                }}
              >
                <span className="hp-view-title">View iframe</span>
                <span className="hp-view-sub">
                  Apps extension · io.modelcontextprotocol/ui ·{" "}
                  <b>{appsOn}</b> of 6 advertised
                </span>
              </button>
              <div className="hp-view-caps">
                {appsCaps.map((row) => {
                  const isSelected =
                    selectedNodeId === appsCapLeafNodeId(row.capKey);
                  return (
                    <button
                      key={row.capKey}
                      type="button"
                      className={cn(
                        "hp-view-cap",
                        !row.on && "hp-view-cap--off",
                        isSelected && "hp-view-cap--selected",
                        row.isChanged && !row.isNewlyOn && "host-matrix-changed",
                        row.isNewlyOn && "host-matrix-newly",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectNode(appsCapLeafNodeId(row.capKey));
                      }}
                    >
                      <span className="hp-view-cap-name">{row.label}</span>
                      {row.on ? (
                        <span className="hp-view-cap-tag">
                          view
                          {row.qualifier ? ` · ${row.qualifier}` : ""}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {/* ===== Host footer ===== */}
        <div className="hp-footer">
          <span className="hp-footer-ext">
            Extensions ·{" "}
            <span className="hp-mono">
              {extensionsLeaf?.value ?? "io.modelcontextprotocol/ui"}
            </span>
          </span>
          {appsExtensionAdvertised ? (
            <button
              type="button"
              className={cn(
                "hp-ctx-btn",
                hostContext?.isChanged && "host-matrix-changed",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(protocolLeafNodeId("hostContext"));
              }}
            >
              hostContext · <b>{extractFieldCount(hostContext?.value)}</b>{" "}
              fields
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
});

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
      className={cn(
        className,
        selectedNodeId === id && "hp-region--selected",
      )}
    >
      {children}
    </button>
  );
}

function PaperStat({
  label,
  value,
  mono,
  muted,
  changed,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
  changed?: boolean;
}) {
  return (
    <div className={cn("hp-stat", changed && "host-matrix-changed")}>
      <span className="hp-stat-label">{label}</span>
      <span
        className={cn(
          "hp-stat-value",
          mono && "hp-mono",
          muted && "hp-stat-value--muted",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * One sandbox config row. Severity drives a left-edge dot color but the
 * row sits inside the amber Sandbox frame, so danger/warn render as
 * subtler in-frame tints than they did on the old dark card.
 */
function SandboxConfigCell({
  row,
  selected,
  onClick,
}: {
  row: SandboxConfigNodeData;
  selected: boolean;
  onClick: () => void;
}) {
  const displayValue =
    row.summary && row.summary !== "—" ? row.summary : semanticAbsence(row.subKey);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "hp-sb-row",
        selected && "hp-sb-row--selected",
        row.severity === "danger" && "hp-sb-row--danger",
        row.severity === "warn" && "hp-sb-row--warn",
        row.isChanged && "host-matrix-changed",
      )}
    >
      <span className="hp-sb-key">{row.label}</span>
      <span
        className={cn(
          "hp-sb-value",
          row.summary === "—" && "hp-sb-value--italic",
        )}
        title={row.summary}
      >
        {displayValue}
      </span>
      {row.qualifier ? (
        <span className="hp-sb-qual" title={row.qualifier}>
          {row.qualifier}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Map an absent sandbox slice ("—" summary) to a semantic word, so the
 * reader sees "any" / "none" / "default" instead of an em-dash that
 * could be confused with "unknown".
 */
function semanticAbsence(key: SandboxConfigNodeData["subKey"]): string {
  switch (key) {
    case "restrictTo":
      return "any origin";
    case "deny":
      return "none";
    case "permissions":
      return "default";
    case "mode":
      return "default";
  }
}

function extractFieldCount(value: string | undefined): number {
  if (!value) return 0;
  const m = value.match(/\d+/);
  return m ? Number(m[0]) : 0;
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
  --hp-ctx-hover: color-mix(in oklch, var(--foreground) 5%, transparent);

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
  padding: 0;
  border: 0;
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
.host-paper-card .hp-dot-sep { color: var(--hp-muted-dim); }

/* === Agent stats === */
.host-paper-card .hp-agents {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  padding: 0 0 22px 0;
  border: 0;
  border-bottom: 1px dashed var(--hp-hairline);
  background: transparent;
  cursor: pointer;
  text-align: left;
  width: 100%;
}
.host-paper-card .hp-agents:hover { background: var(--hp-region-hover); }
.host-paper-card .hp-stat {
  padding: 0 16px;
  border-right: 1px dashed var(--hp-hairline);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.host-paper-card .hp-stat:first-child { padding-left: 0; }
.host-paper-card .hp-stat:last-child { border-right: 0; padding-right: 0; }
.host-paper-card .hp-stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--hp-muted-dim);
  font-weight: 500;
}
.host-paper-card .hp-stat-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--hp-ink);
  letter-spacing: -0.005em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-paper-card .hp-stat-value--muted { color: var(--hp-muted); }

/* === Section (Client capabilities) === */
.host-paper-card .hp-section { display: flex; flex-direction: column; gap: 12px; }
.host-paper-card .hp-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
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
.host-paper-card .hp-section-count {
  font-size: 12.5px;
  color: var(--hp-muted);
  font-variant-numeric: tabular-nums;
}
.host-paper-card .hp-section-count b { color: var(--hp-ink); font-weight: 600; }
.host-paper-card .hp-section-meta { color: var(--hp-muted-dim); }

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

/* === Sandbox nested frame === */
.host-paper-card .hp-sandbox {
  background: var(--hp-sandbox-bg);
  border: 1px solid var(--hp-sandbox-ring);
  border-radius: 14px;
  padding: 20px 20px 22px;
  color: var(--hp-sandbox-ink);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.host-paper-card .hp-frame-head {
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: inherit;
}
.host-paper-card .hp-sandbox-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hp-sandbox-accent);
  letter-spacing: -0.01em;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* Small tag next to the Sandbox title that signals the rows below
   (mode / restrictTo / deny / permissions) are MCPJam's policy
   abstractions, not raw spec terms. Quiet enough to skim past once
   you know what it means, loud enough to keep readers honest. */
.host-paper-card .hp-policy-tag {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 2px 6px 3px;
  border-radius: 4px;
  border: 1px solid var(--hp-sandbox-ring);
  color: var(--hp-sandbox-sub);
  background: var(--hp-paper-surface);
}
.host-paper-card .hp-sandbox-sub {
  font-size: 12.5px;
  color: var(--hp-sandbox-sub);
}

.host-paper-card .hp-sb-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 18px;
}
.host-paper-card .hp-sb-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: baseline;
  padding: 5px 8px;
  border-radius: 8px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 12.5px;
  color: var(--hp-sandbox-ink);
  border-bottom: 1px dashed var(--hp-sandbox-hairline);
  transition: background 120ms ease;
}
.host-paper-card .hp-sb-row:hover { background: var(--hp-sandbox-row-hover); }
.host-paper-card .hp-sb-row--selected { background: var(--hp-sandbox-row-selected); }
.host-paper-card .hp-sb-row--warn {
  background: color-mix(in oklch, var(--warning) 12%, transparent);
}
.host-paper-card .hp-sb-row--warn:hover {
  background: color-mix(in oklch, var(--warning) 18%, transparent);
}
.host-paper-card .hp-sb-row--danger {
  background: color-mix(in oklch, var(--destructive) 12%, transparent);
}
.host-paper-card .hp-sb-row--danger:hover {
  background: color-mix(in oklch, var(--destructive) 18%, transparent);
}
.host-paper-card .hp-sb-key {
  color: var(--hp-sandbox-sub);
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 11.5px;
}
.host-paper-card .hp-sb-value {
  text-align: right;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 11.5px;
  color: var(--hp-sandbox-ink);
  font-weight: 500;
}
.host-paper-card .hp-sb-value--italic {
  font-style: italic;
  font-weight: 400;
  color: var(--hp-sandbox-sub);
  font-family: inherit;
  font-size: 12.5px;
}
.host-paper-card .hp-sb-qual {
  text-align: right;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 10.5px;
  color: var(--hp-sandbox-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

/* === View nested-nested frame === */
.host-paper-card .hp-view {
  background: var(--hp-view-bg);
  border: 1px solid var(--hp-view-ring);
  border-radius: 12px;
  padding: 16px 18px 18px;
  color: var(--hp-view-ink);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.host-paper-card .hp-view-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--hp-view-accent);
  letter-spacing: -0.01em;
}
.host-paper-card .hp-view-sub {
  font-size: 12px;
  color: var(--hp-view-sub);
}
.host-paper-card .hp-view-sub b { color: var(--hp-view-ink); font-weight: 600; }
.host-paper-card .hp-view-caps {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.host-paper-card .hp-view-cap {
  display: inline-flex;
  align-items: baseline;
  background: var(--hp-paper-surface);
  border: 1px solid var(--hp-view-ring);
  color: var(--hp-view-ink);
  border-radius: 999px;
  padding: 4px 11px 5px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: transform 120ms ease;
  font-family: ui-monospace, "JetBrains Mono", monospace;
}
.host-paper-card .hp-view-cap:hover { transform: translateY(-1px); }
.host-paper-card .hp-view-cap--off {
  background: transparent;
  color: var(--hp-view-sub);
  border-style: dashed;
  font-weight: 400;
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklch, var(--muted-foreground) 60%, transparent);
  text-decoration-thickness: 0.5px;
}
.host-paper-card .hp-view-cap--selected {
  background: var(--hp-view-cap-selected-bg);
  border-color: var(--hp-view-ink);
}
.host-paper-card .hp-view-cap-name {
  font-weight: 500;
}
.host-paper-card .hp-view-cap-tag {
  font-size: 10px;
  color: var(--hp-view-sub);
  margin-left: 6px;
  padding-left: 6px;
  border-left: 1px solid var(--hp-view-ring);
  font-weight: 400;
  font-family: inherit;
}

/* === Host footer === */
.host-paper-card .hp-footer {
  margin-top: 4px;
  padding-top: 16px;
  border-top: 1px dashed var(--hp-hairline);
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--hp-muted);
  font-size: 12px;
  gap: 12px;
  flex-wrap: wrap;
}
.host-paper-card .hp-footer-ext {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.host-paper-card .hp-footer-ext .hp-mono {
  color: var(--hp-ink);
  font-size: 11.5px;
}
.host-paper-card .hp-ctx-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 0;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--hp-muted);
  font: inherit;
  font-weight: 500;
  font-size: 12px;
}
.host-paper-card .hp-ctx-btn:hover {
  color: var(--hp-ink);
  background: var(--hp-ctx-hover);
}
.host-paper-card .hp-ctx-btn b { color: var(--hp-ink); font-weight: 600; }
.host-paper-card .hp-ctx-btn svg { width: 11px; height: 11px; }

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
