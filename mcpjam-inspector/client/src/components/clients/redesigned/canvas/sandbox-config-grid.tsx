/**
 * SandboxConfigGrid
 *
 * Portable two-column grid of sandbox-config rows. Originally lived inline
 * inside `ClientCapabilityMatrix.tsx` under the "Sandbox proxy iframe"
 * card; lifted here so the chat-thread Sandbox debug panel can render the
 * same widget from the resolved MCP-Apps runtime payload, not just from
 * the host-config matrix.
 *
 * The visual shell (frame chrome, heading, etc.) is owned by the caller.
 * This component renders ONLY the grid of rows + the optional per-
 * directive expansion that follows a row when it carries `directives`.
 *
 * CSS lives in `./sandbox-config-grid.css`. Important: the `--hp-sandbox-*`
 * vars referenced by these rules are declared inside `.host-paper-card`
 * over in the matrix (at PAPER_STYLES) — when this grid renders OUTSIDE
 * the matrix (e.g. inside a chat-thread debug panel that has no
 * `.host-paper-card` ancestor), the CSS file declares the same vars on
 * the `.sandbox-config-grid` selector itself so the grid keeps working
 * regardless of context.
 */
import { memo } from "react";
import { cn } from "@/lib/utils";
import type {
  SandboxConfigNodeData,
  SandboxConfigSubKey,
} from "../types";
import type { SandboxConfigDescriptor } from "./canvasBuilder";
import "./sandbox-config-grid.css";

/**
 * Subset of `SandboxConfigDescriptor` we need to render a row. We accept
 * the wrapped `SandboxConfigNodeData` shape that the matrix's canvas
 * builder already emits — callers passing the raw `SandboxConfigDescriptor`
 * from `buildSandboxConfig` use `descriptorToNodeData` below.
 */
export interface SandboxConfigGridProps {
  rows: SandboxConfigNodeData[];
  /** Optional click handler — receives the row's subKey (e.g. "restrictTo"). */
  onRowSelect?: (subKey: SandboxConfigSubKey) => void;
  /** Highlights one row by subKey. */
  selectedSubKey?: SandboxConfigSubKey | null;
  className?: string;
}

/**
 * Convert a raw `SandboxConfigDescriptor` (from `buildSandboxConfig`) into
 * the wrapped `SandboxConfigNodeData` shape this grid renders. The canvas
 * builder does this same wrap inline (adding `kind` and `isChanged`); we
 * expose it so non-matrix consumers (the chat-thread Sandbox panel) can
 * pass `buildSandboxConfig(...)` output straight through without recreating
 * the field mapping.
 */
export function descriptorToNodeData(
  d: SandboxConfigDescriptor,
): SandboxConfigNodeData {
  return {
    kind: "sandbox-config-leaf",
    subKey: d.subKey,
    label: d.label,
    summary: d.summary,
    qualifier: d.qualifier,
    severity: d.severity,
    isChanged: false,
    directives: d.directives,
  };
}

export const SandboxConfigGrid = memo(function SandboxConfigGrid({
  rows,
  onRowSelect,
  selectedSubKey,
  className,
}: SandboxConfigGridProps) {
  if (rows.length === 0) return null;
  return (
    <div className={cn("sandbox-config-grid", className)}>
      {rows.map((row) => (
        <SandboxConfigCell
          key={row.subKey}
          row={row}
          selected={selectedSubKey === row.subKey}
          onClick={
            onRowSelect ? () => onRowSelect(row.subKey) : undefined
          }
        />
      ))}
    </div>
  );
});

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
  onClick?: () => void;
}) {
  const displayValue =
    row.summary && row.summary !== "—"
      ? row.summary
      : semanticAbsence(row.subKey);
  // Per-directive token chips intentionally NOT rendered inline. For rows
  // like cspDirectives with 10+ directives × multiple tokens each, an
  // always-expanded chip list overwhelms the matrix and pushes downstream
  // sections (View iframe, Servers) off-screen. The row's summary
  // ("10 directives · 25 source expressions") conveys cardinality at a glance; the
  // structured editor in ClientConfigEditor.tsx is where the per-directive
  // detail belongs. We surface the breakdown as a `title=` tooltip on the
  // qualifier so power users can hover without losing the layout.
  const directives = row.directives ?? [];
  const directivesTooltip =
    directives.length > 0
      ? directives
          .map((d) => `${d.label}: ${d.domains.join(" ")}`)
          .join("\n")
      : undefined;
  return (
    <button
      type="button"
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      className={cn(
        "hp-sb-row",
        selected && "hp-sb-row--selected",
        row.severity === "danger" && "hp-sb-row--danger",
        row.severity === "warn" && "hp-sb-row--warn",
        row.isChanged && "host-matrix-changed",
        !onClick && "hp-sb-row--static",
      )}
      // Buttons inherit `cursor: pointer` from the global stylesheet — when
      // no handler is provided we still want pointer behavior off so the row
      // doesn't look interactive.
      disabled={!onClick}
    >
      <span className="hp-sb-key">{row.label}</span>
      <span className="hp-sb-value-line">
        <span
          className={cn(
            "hp-sb-value",
            row.summary === "—" && "hp-sb-value--italic",
          )}
          title={directivesTooltip ?? row.summary}
        >
          {displayValue}
        </span>
        {row.qualifier ? (
          <span
            className="hp-sb-qual"
            title={directivesTooltip ?? row.qualifier}
          >
            {row.qualifier}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Map an absent sandbox slice ("—" summary) to a semantic word, so the
 * reader sees "default" / "none granted" instead of an em-dash that
 * could be confused with "unknown".
 *
 * Note: `restrictTo` / `cspDirectives` / `sandboxAttrs` / `allowFeatures`
 * are not listed here — canvasBuilder skips those rows entirely when at
 * the safe default, so this helper is only called for `mode` and
 * `permissions`.
 */
export function semanticAbsence(key: SandboxConfigSubKey): string {
  switch (key) {
    case "permissions":
      // SEP-1865 is allowlist-only: an empty `allow` map means no permission
      // is granted, regardless of the inspector-internal resolver mode.
      return "none granted";
    case "mode":
      return "default";
    case "restrictTo":
    case "cspDirectives":
    case "sandboxAttrs":
    case "allowFeatures":
      // Unreachable — canvasBuilder drops these rows when they're at the
      // safe default. Kept for type exhaustiveness.
      return "";
  }
}
