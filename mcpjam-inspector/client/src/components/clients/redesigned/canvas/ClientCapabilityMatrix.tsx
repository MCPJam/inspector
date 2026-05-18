import { memo, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
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
} from "../types";

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
  selectedNodeId,
  onSelectNode,
}: HostMatrixCardProps) {
  const connectedClientCaps = clientCaps.filter((row) => row.on);

  const timeoutLeaf = protocolBand.find((l) => l.leafKey === "timeout");
  const clientInfoLeaf = protocolBand.find((l) => l.leafKey === "clientInfo");
  const protocolVersionLeaf = protocolBand.find(
    (l) => l.leafKey === "protocolVersion",
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
              <span className="hp-sandbox-title">Sandbox proxy iframe</span>
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

            {/* ===== View nested-nested frame =====
                Empty state: surfaces `mcpProfile.apps.uiInitialize` — the
                hostInfo line matches what a view receives over the wire when
                one connects (SEP-1865). */}
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
              </button>
              <ViewIframeEmptyState hostInfo={hostInfo} />
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
});

/* Empty-state body for the View iframe frame: `uiInitialize` envelope only,
   optionally followed by the resolved hostInfo (name + version). */
function ViewIframeEmptyState({
  hostInfo,
}: {
  hostInfo: { name: string; version: string } | null;
}) {
  return (
    <div className="hp-view-empty">
      <span className="hp-view-empty-payload">
        <span className="hp-view-empty-payload-key">uiInitialize</span>
        {hostInfo ? (
          <>
            <span className="hp-view-empty-payload-arrow" aria-hidden>
              →
            </span>
            <span className="hp-view-empty-payload-value">
              hostInfo · <b>{hostInfo.name}</b>
              <span className="hp-view-empty-payload-version">
                {hostInfo.version}
              </span>
            </span>
          </>
        ) : null}
      </span>
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
      className={cn(
        className,
        selectedNodeId === id && "hp-region--selected",
      )}
    >
      {children}
    </button>
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
  const directives = row.directives ?? [];
  return (
    <div
      className={cn(
        "hp-sb-cell",
        directives.length > 0 && "hp-sb-cell--with-directives",
      )}
    >
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
      {directives.length > 0 ? (
        <ul className="hp-sb-directives" aria-label={`${row.label} directives`}>
          {directives.map((d) => (
            <li key={d.key} className="hp-sb-directive">
              <span className="hp-sb-directive-label">{d.label}</span>
              <span className="hp-sb-directive-domains">
                {d.domains.map((domain) => (
                  <span key={domain} className="hp-sb-directive-domain">
                    {domain}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Map an absent sandbox slice ("—" summary) to a semantic word, so the
 * reader sees "default" / "none granted" instead of an em-dash that
 * could be confused with "unknown".
 *
 * Note: `restrictTo` is not listed here — canvasBuilder skips the row
 * entirely when restrictTo is empty (the safe default), so this helper
 * is only called for `mode` and `permissions`.
 */
function semanticAbsence(key: SandboxConfigNodeData["subKey"]): string {
  switch (key) {
    case "permissions":
      // SEP-1865 is allowlist-only: an empty `allow` map means no permission
      // is granted, regardless of the inspector-internal resolver mode.
      return "none granted";
    case "mode":
      return "default";
    case "restrictTo":
      // Unreachable — canvasBuilder drops the row when restrictTo is
      // empty. Kept for type exhaustiveness.
      return "";
  }
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
  gap: 0;
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
/* View-iframe empty-state: uiInitialize line (+ optional hostInfo detail). */
.host-paper-card .hp-view-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 4px 2px;
  border-top: 1px dashed
    color-mix(in oklch, var(--diagram-view) 30%, var(--border));
}
.host-paper-card .hp-view-empty-payload {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 11.5px;
  color: var(--hp-view-ink);
}
.host-paper-card .hp-view-empty-payload-key {
  color: var(--hp-view-sub);
}
.host-paper-card .hp-view-empty-payload-arrow {
  color: var(--hp-view-sub);
}
.host-paper-card .hp-view-empty-payload-value b {
  font-weight: 600;
  color: var(--hp-view-ink);
}
.host-paper-card .hp-view-empty-payload-version {
  margin-left: 6px;
  padding-left: 6px;
  border-left: 1px solid var(--hp-view-ring);
  color: var(--hp-view-sub);
  font-size: 10.5px;
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
