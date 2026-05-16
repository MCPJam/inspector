import { memo } from "react";
import { cn } from "@/lib/utils";
import {
  AGENT_IDENTITY_NODE_ID,
  APPS_HUB_NODE_ID,
  HOST_GROUP_NODE_ID,
  PROTOCOL_HUB_NODE_ID,
  appsCapLeafNodeId,
  protocolLeafNodeId,
  type AgentIdentityNodeData,
  type AppsCapLeafNodeData,
  type ClientCapRow,
  type ProtocolLeafNodeData,
} from "../types";

/* ============================================================
   Pure presentational card. Receives pre-computed data from the
   canvas builder; renders the matrix layout used inside the
   ReactFlow host node. No outer shell, no servers strip — those
   are the parent canvas's concern.
   ============================================================ */
export interface HostMatrixCardProps {
  hostName: string;
  agent: AgentIdentityNodeData | null;
  protocolBand: ProtocolLeafNodeData[];
  clientCaps: ClientCapRow[];
  appsCaps: AppsCapLeafNodeData[];
  /**
   * When false, the entire Apps extension section (banner, rows, and
   * footer "apps" count) is hidden — host-side Apps caps are inert
   * unless the client advertises `io.modelcontextprotocol/ui`.
   */
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
  appsExtensionAdvertised,
  hostContext,
  selectedNodeId,
  onSelectNode,
}: HostMatrixCardProps) {
  const clientOn = clientCaps.filter((c) => c.on).length;
  const appsOn = appsCaps.filter((c) => c.on).length;

  return (
    <article className="host-matrix-card w-full overflow-hidden rounded-2xl border border-border/70 bg-card/95 shadow-sm">
      <style>{MATRIX_STYLES}</style>

      {/* Identity strip — clickable opens General tab */}
      <Region
        id={HOST_GROUP_NODE_ID}
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
        className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-3"
      >
        <ProviderGlyph provider={agent?.modelProvider ?? null} />
        <div className="flex min-w-0 flex-col">
          <span
            className="truncate text-[13.5px] font-semibold leading-tight"
            title={hostName}
          >
            {hostName}
          </span>
          <span
            className="truncate font-mono text-[10.5px] text-muted-foreground"
            title={agent?.modelLabel ?? ""}
          >
            {agent?.modelLabel ?? "No model selected"}
          </span>
        </div>
      </Region>

      {/* Agent stats */}
      <Region
        id={AGENT_IDENTITY_NODE_ID}
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
        className="grid w-full grid-cols-4 gap-px border-b border-border/60 bg-border/60"
      >
        <Stat
          label="temp"
          value={agent?.temperature.toFixed(2) ?? "—"}
          changed={agent?.changedFields.includes("temperature")}
        />
        <Stat
          label="style"
          value={agent?.hostStyleLabel ?? "—"}
          changed={agent?.changedFields.includes("hostStyle")}
        />
        <Stat
          label="approve"
          value={agent ? (agent.toolApproval ? "on" : "off") : "—"}
          changed={agent?.changedFields.includes("toolApproval")}
        />
        <Stat
          label="prompt"
          value={agent?.systemPromptEmpty ? "∅" : "set"}
          empty={agent?.systemPromptEmpty}
          changed={agent?.changedFields.includes("systemPrompt")}
        />
      </Region>

      {/* Protocol band */}
      <Region
        id={PROTOCOL_HUB_NODE_ID}
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
        className="grid w-full gap-px border-b border-border/60 bg-border/60"
        style={{
          gridTemplateColumns: `repeat(${Math.max(protocolBand.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        {protocolBand.length === 0 ? (
          <ProtocolCell label="protocol" value="SDK defaults" />
        ) : (
          protocolBand.map((leaf) => (
            <ProtocolCell
              key={leaf.leafKey}
              label={leaf.label}
              value={leaf.value}
              changed={leaf.isChanged}
            />
          ))
        )}
      </Region>

      {/* Client capabilities sub-matrix */}
      <SectionBanner
        label="Client capabilities"
        meta={
          <>
            <b className="font-medium text-foreground/85">{clientOn}/5</b>
            {"  ·  base protocol"}
          </>
        }
        onClick={() => onSelectNode(PROTOCOL_HUB_NODE_ID)}
      />
      <MatrixHead cols={["", "capability", "sub-capabilities"]} merged />
      {clientCaps.map((row) => (
        <MatrixRow
          key={row.key}
          kind="mcp"
          on={row.on}
          changed={row.isChanged && !row.isNewlyOn}
          newly={row.isNewlyOn}
          selected={false}
          onClick={() => onSelectNode(PROTOCOL_HUB_NODE_ID)}
        >
          <span
            className={cn(
              "font-mono text-[11px]",
              row.on
                ? "text-foreground/95"
                : "text-muted-foreground line-through decoration-muted-foreground/60",
            )}
          >
            {row.key}
          </span>
          <span className="flex justify-end gap-1 overflow-hidden whitespace-nowrap font-mono text-[10px] text-muted-foreground">
            {row.subs.length === 0 ? (
              <span className="text-muted-foreground/60">—</span>
            ) : (
              row.subs.map((s) => <SubTag key={s}>{s}</SubTag>)
            )}
          </span>
        </MatrixRow>
      ))}

      {/* Apps extension sub-matrix — hidden when the client doesn't
          advertise `io.modelcontextprotocol/ui`. Host-side Apps caps
          (openLinks / serverTools / message / etc.) are meaningless
          for a client that can't render iframes (e.g. codex-mcp-client). */}
      {appsExtensionAdvertised ? (
        <>
          <SectionBanner
            label="Apps extension"
            meta={
              <>
                <b className="font-medium text-foreground/85">{appsOn}/6</b>
                {"  ·  io.modelcontextprotocol/ui"}
              </>
            }
            onClick={() => onSelectNode(APPS_HUB_NODE_ID)}
          />
          <MatrixHead cols={["", "capability", "scope", "content"]} />
          {appsCaps.map((row) => (
            <MatrixRow
              key={row.capKey}
              kind="apps"
              on={row.on}
              changed={row.isChanged && !row.isNewlyOn}
              newly={row.isNewlyOn}
              selected={selectedNodeId === appsCapLeafNodeId(row.capKey)}
              onClick={() => onSelectNode(appsCapLeafNodeId(row.capKey))}
            >
              <span
                className={cn(
                  "font-mono text-[11px]",
                  row.on
                    ? "text-foreground/95"
                    : "text-muted-foreground line-through decoration-muted-foreground/60",
                )}
              >
                {row.label}
              </span>
              <span className="text-right font-mono text-[10px] text-muted-foreground">
                {row.on ? "view" : "—"}
              </span>
              <span className="text-right font-mono text-[10px] text-muted-foreground">
                {row.on ? row.qualifier ?? "—" : "—"}
              </span>
            </MatrixRow>
          ))}
        </>
      ) : null}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border/60 bg-foreground/[0.015] px-3.5 py-2 font-mono text-[10px] text-muted-foreground">
        <span>
          <b className="font-medium text-foreground/85">{clientOn}/5</b> client
          {appsExtensionAdvertised ? (
            <>
              {" · "}
              <b className="font-medium text-foreground/85">{appsOn}/6</b> apps
            </>
          ) : null}
        </span>
        {/* hostContext is part of SEP-1865 (the Apps extension); skip it
            entirely when the client doesn't advertise the UI extension. */}
        {appsExtensionAdvertised ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectNode(protocolLeafNodeId("hostContext"));
            }}
            className={cn(
              "rounded px-1.5 py-0.5 hover:bg-foreground/[0.04]",
              hostContext?.isChanged && "text-[oklch(0.83_0.17_75)]",
            )}
          >
            hostContext ·{" "}
            <b className="font-medium text-foreground/85">
              {extractFieldCount(hostContext?.value)}
            </b>{" "}
            fields
          </button>
        ) : null}
      </div>
    </article>
  );
});

/* ---------------- subcomponents ---------------- */

function ProviderGlyph({ provider }: { provider: string | null }) {
  const letter = provider ? provider.charAt(0).toUpperCase() : "?";
  return (
    <span
      aria-hidden
      className="inline-flex size-7 items-center justify-center rounded-md bg-foreground/90 text-[11px] font-semibold uppercase text-background"
    >
      {letter}
    </span>
  );
}

function Status({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full",
        on ? "bg-emerald-400" : "bg-muted-foreground/35",
      )}
      style={
        on
          ? { boxShadow: "0 0 6px color-mix(in oklch, currentColor 55%, transparent)" }
          : undefined
      }
    />
  );
}

/**
 * A clickable region that participates in the canvas's selection
 * model. Stops propagation so the outer ReactFlow node's onClick
 * doesn't also fire — sub-region selection wins over whole-node.
 */
function Region({
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
  style?: React.CSSProperties;
  children: React.ReactNode;
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
        "text-left hover:bg-foreground/[0.025]",
        selectedNodeId === id && "bg-foreground/[0.04]",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Stat({
  label,
  value,
  empty,
  changed,
}: {
  label: string;
  value: string;
  empty?: boolean;
  changed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 bg-card/95 px-3 py-2",
        changed && "host-matrix-changed",
      )}
    >
      <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-muted-foreground/85">
        {label}
      </span>
      <span
        className={cn(
          "truncate font-mono text-[11px]",
          empty ? "text-amber-500" : "text-foreground/95",
          changed && "text-[oklch(0.83_0.17_75)]",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function ProtocolCell({
  label,
  value,
  changed,
}: {
  label: string;
  value: string;
  changed?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-0.5 bg-card/95 px-3 py-2",
        changed && "host-matrix-changed",
      )}
    >
      <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-muted-foreground/85">
        {label}
      </span>
      <span
        className={cn(
          "truncate font-mono text-[11px]",
          changed ? "text-[oklch(0.83_0.17_75)]" : "text-foreground/95",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function SectionBanner({
  label,
  meta,
  onClick,
}: {
  label: string;
  meta: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className="flex w-full items-baseline justify-between border-t border-border/60 px-3.5 pb-1.5 pt-3 text-left first:border-t-0 hover:bg-foreground/[0.025]"
    >
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.22em] text-foreground/85">
        {label}
      </span>
      <span className="font-mono text-[9.5px] text-muted-foreground">
        {meta}
      </span>
    </button>
  );
}

function MatrixHead({
  cols,
  merged,
}: {
  cols: string[];
  merged?: boolean;
}) {
  return (
    <div
      className="grid items-center gap-x-2.5 border-b border-dashed border-border/60 px-3.5 py-1.5"
      style={{
        gridTemplateColumns: merged
          ? "16px minmax(0, 1fr) auto"
          : "16px minmax(0, 1fr) 56px 70px",
      }}
    >
      {cols.map((c, i) => (
        <span
          key={i}
          className={cn(
            "font-mono text-[8.5px] uppercase tracking-[0.18em] text-muted-foreground/80",
            i >= 2 && "text-right",
          )}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function MatrixRow({
  kind,
  on,
  changed,
  newly,
  selected,
  onClick,
  children,
}: {
  kind: "mcp" | "apps";
  on: boolean;
  /** Background flash when the row's on/off or sub-tags differ from prev host. */
  changed?: boolean;
  /** Stronger highlight: row flipped from off → on on the last host switch. */
  newly?: boolean;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "relative grid w-full items-center gap-x-2.5 border-b border-dashed border-border/40 px-3.5 py-1.5 text-left last:border-b-0 hover:bg-foreground/[0.025]",
        !on && "opacity-65",
        selected && "bg-foreground/[0.04]",
        changed && !newly && "host-matrix-changed",
        newly && "host-matrix-newly",
      )}
      style={{
        gridTemplateColumns:
          kind === "mcp"
            ? "16px minmax(0, 1fr) auto"
            : "16px minmax(0, 1fr) 56px 70px",
      }}
    >
      <span className="flex w-4 items-center justify-center">
        <Status on={on} />
      </span>
      {children}
    </button>
  );
}

function SubTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[3px] border border-border/60 bg-foreground/[0.03] px-1.5 py-px font-mono text-[9.5px] text-muted-foreground">
      {children}
    </span>
  );
}

function extractFieldCount(value: string | undefined): number {
  if (!value) return 0;
  const m = value.match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/* ---------------- inline styles ---------------- */
const MATRIX_STYLES = `
@keyframes hostMatrixDiffFlash {
  0% { background-color: oklch(0.83 0.17 75 / 0.32); }
  100% { background-color: transparent; }
}
.host-matrix-changed {
  animation: hostMatrixDiffFlash 1.8s ease-out;
}
.host-matrix-newly {
  box-shadow: inset 2px 0 0 oklch(0.83 0.17 75);
  animation: hostMatrixDiffFlash 1.8s ease-out;
}
`;
