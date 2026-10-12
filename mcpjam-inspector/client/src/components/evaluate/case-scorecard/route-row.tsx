import { useSpineDrag } from "../case-spine/spine-drag";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@mcpjam/design-system/dropdown-menu";
/**
 * The route: the first scorer under Selection.
 *
 * "Which tool should handle it?" IS the `toolCalls:match` scorer, and the old
 * Capability | Regression toggle IS that scorer's strictness. They sat in
 * separate blocks under a heading ("Check the result") that described the
 * whole page, so the most important scorer on the case was the one thing not
 * called a scorer. Folding both into one row under Selection puts the answer
 * where a reader looks for it and removes a heading that was never true.
 *
 * Nothing on the wire changes: the row writes `toolCalledWith` assert steps
 * through `writeSimpleCase`, and the mode still writes `kind` plus
 * `matchOptions` together.
 */

import { useState } from "react";
import { Loader2, Plus, RotateCw, Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@mcpjam/design-system/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import {
  ToolCalledWithFields,
  type ToolArgSchemas,
} from "@/components/evals/checks-section";
import { toolNameWarning } from "@/components/evals/tool-name-warning";
import { RoleChip } from "@/components/evals/scorer-role-control";
import { UNSET_TOOLS_BLOCK_REASON } from "../simple-case/simple-case-model";
import type {
  CaseKind,
  SimpleCaseTool,
} from "../simple-case/simple-case-model";
import {
  StatusDot,
  overlayStatus,
  type SimpleCaseOverlay,
} from "../simple-case/status-dot";
import { RowMarker } from "./row-marker";
import type { ScorecardRow } from "./case-scorecard-model";
import type { Predicate } from "@/shared/eval-matching";

/** Why a suite server's tools are missing; absent once each has loaded. */
export type ToolCatalogStatus = "loading" | "error";

export function RouteRow({
  row,
  availableTools,
  toolArgSchemas,
  toolsStatus,
  onRetryTools,
  readOnly,
  overlay,
  showUnsetError,
  negativeContradiction,
  onSetTools,
  onChooseNoTool,
  onChooseTools,
  onAddTool,
  onSetKind,
  turnScoped = false,
  newestStepId,
  paper = false,
  toolPredicate,
  onChangeToolPredicate,
}: {
  row: ScorecardRow;
  availableTools?: string[];
  toolArgSchemas?: ToolArgSchemas;
  toolsStatus?: ToolCatalogStatus;
  onRetryTools?: () => void;
  readOnly: boolean;
  overlay?: SimpleCaseOverlay | null;
  showUnsetError: boolean;
  negativeContradiction: boolean;
  onSetTools: (tools: SimpleCaseTool[]) => void;
  onChooseNoTool: () => void;
  onChooseTools: () => void;
  onAddTool: (toolName: string) => void;
  onSetKind: (kind: CaseKind) => void;
  /**
   * The tools ONE later prompt expects, under that prompt. The case-wide
   * controls (matching options, "No tool should be called") stay on the first
   * prompt's block, so this shows only the tools and the picker.
   */
  turnScoped?: boolean;
  newestStepId?: string;
  paper?: boolean;
  toolPredicate?: Extract<Predicate, { type: "toolCalledWith" }>;
  onChangeToolPredicate?: (
    next: Extract<Predicate, { type: "toolCalledWith" }>,
  ) => void;
}) {
  const route = row.route;
  if (!route) return null;
  const locked = route.kind === "locked" || readOnly;
  const tools =
    route.kind === "tools" || route.kind === "locked" ? route.tools : [];
  const matchMode: CaseKind =
    route.kind === "tools" ? route.matchMode : "capability";

  const routeControls = (
    <>
      {turnScoped ? null : (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">Matching options</summary>
          <div className="flex flex-wrap items-center gap-2 py-2">
            {" "}
            {route.kind === "tools" ? (
              <ToggleGroup
                type="single"
                value={matchMode}
                onValueChange={(value) => {
                  if (value === "capability" || value === "regression") {
                    onSetKind(value);
                  }
                }}
                className="shrink-0 gap-0.5"
                aria-label="Route match mode"
                disabled={locked}
              >
                <ToggleGroupItem
                  value="capability"
                  className="h-6 px-2 text-[11px]"
                >
                  Reach the tool
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="regression"
                  className="h-6 px-2 text-[11px]"
                >
                  Exact route
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
          </div>
          {route.kind === "tools" && matchMode === "regression" ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              Strict order, no extra calls; arguments compared as pinned.
            </p>
          ) : null}
        </details>
      )}

      {/* The route choice decides the route itself, so it stays visible
            outside the collapsed matching options. */}
      {turnScoped ? null : route.kind === "locked" ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="simple-case-route-locked"
        >
          {route.reason === "modelFree"
            ? "This case runs a pinned tool call, so no model route applies. Edit it in Steps."
            : "This case does not start with a prompt. Edit it in Steps."}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={route.kind === "noTool" ? "secondary" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={onChooseNoTool}
            disabled={readOnly}
          >
            No tool should be called
          </Button>
          {route.kind === "noTool" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onChooseTools}
              disabled={readOnly}
            >
              Use tools instead
            </Button>
          ) : null}
        </div>
      )}

      {showUnsetError && !turnScoped ? (
        <p
          className="text-[11px] text-destructive"
          data-testid="simple-case-tools-unset"
        >
          {UNSET_TOOLS_BLOCK_REASON}
        </p>
      ) : null}

      {negativeContradiction && !turnScoped ? (
        <p
          className="text-[11px] text-destructive"
          data-testid="simple-case-negative-contradiction"
        >
          This case says no tool should be called, but an assertion that
          requires a tool call still applies — from the suite, this case, or a
          step. Those cannot both hold.
        </p>
      ) : null}
    </>
  );

  return (
    <li
      data-testid="case-route-row"
      data-row-key={row.key}
      data-route={route.kind}
      data-role={row.role}
      data-turn-scoped={turnScoped || undefined}
      className={
        paper && tools.length
          ? "bg-card"
          : "overflow-hidden rounded-lg border border-border bg-card"
      }
    >
      {paper && tools.length ? null : (
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2.5">
          <RowMarker row={row} />

          <span
            className="min-w-0 flex-1 truncate text-xs text-foreground"
            title={row.tooltip}
          >
            {route.kind === "tools" ? "Tool was called with…" : row.label}
          </span>
          <RoleChip role={row.role} />
        </div>
      )}
      <div
        className={
          paper && tools.length ? "divide-y divide-border" : "space-y-3 p-3"
        }
      >
        {paper && tools.length ? null : routeControls}
        {route.kind !== "noTool" ? (
          <div className={paper ? "divide-y divide-border" : "space-y-2"}>
            {tools.map((tool) => (
              <SortableToolRow
                key={tool.id}
                id={tool.id}
                disabled={locked || !paper}
                className={cn(
                  paper
                    ? "relative space-y-1.5 py-2.5 pl-8 pr-11"
                    : "relative space-y-1 border-b border-border pb-3 last:border-b-0",
                  newestStepId === tool.id &&
                    (paper
                      ? "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary"
                      : "before:absolute before:inset-y-0 before:-left-3 before:w-[3px] before:bg-primary"),
                )}
                data-newest={newestStepId === tool.id || undefined}
                data-testid="simple-case-tool-row"
              >
                {paper ? (
                  <p className="text-[13px] font-semibold leading-[18px] text-card-foreground">
                    Tool was called with…
                  </p>
                ) : null}
                <div className="absolute right-2 top-2">
                  <div className="flex items-center gap-1">
                    <StatusDot status={overlayStatus(overlay, tool.id)} />
                    {locked ? null : paper ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label={`Options for ${tool.toolName || "tool"}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              onSetTools(
                                tools.filter((row) => row.id !== tool.id),
                              )
                            }
                          >
                            Remove {tool.toolName || "tool"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground"
                        aria-label={`Remove ${tool.toolName || "tool"}`}
                        onClick={() =>
                          onSetTools(tools.filter((row) => row.id !== tool.id))
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <ToolCalledWithFields
                  paper={!readOnly}
                  compact={readOnly}
                  predicate={
                    toolPredicate ?? {
                      type: "toolCalledWith",
                      toolName: tool.toolName,
                      args: {
                        args: matchMode === "regression" ? tool.arguments : {},
                        argumentMatching:
                          matchMode === "regression" ? "partial" : "ignore",
                      },
                    }
                  }
                  onChange={(next) => {
                    if (next.type !== "toolCalledWith") return;
                    if (onChangeToolPredicate) {
                      onChangeToolPredicate(next);
                      return;
                    }
                    onSetTools(
                      tools.map((row) =>
                        row.id === tool.id
                          ? {
                              ...row,
                              toolName: next.toolName,
                              arguments:
                                matchMode === "regression"
                                  ? (next.args.args ?? {})
                                  : {},
                            }
                          : row,
                      ),
                    );
                  }}
                  availableTools={availableTools}
                  toolArgSchemas={toolArgSchemas}
                  readOnly={locked}
                />
              </SortableToolRow>
            ))}
            {locked || (paper && tools.length) ? null : (
              <AddToolRow
                availableTools={availableTools ?? []}
                toolsStatus={toolsStatus}
                onRetryTools={onRetryTools}
                onAdd={onAddTool}
              />
            )}
          </div>
        ) : null}
        {paper && tools.length && !turnScoped ? (
          <details className="px-8 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Tool matching settings</summary>
            <div className="space-y-2 pt-2">
              {routeControls}
              {locked ? null : (
                <AddToolRow
                  availableTools={availableTools ?? []}
                  toolsStatus={toolsStatus}
                  onRetryTools={onRetryTools}
                  onAdd={onAddTool}
                />
              )}
            </div>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function SortableToolRow({
  id,
  disabled,
  children,
  ...props
}: { id: string; disabled: boolean; children: ReactNode } & Omit<
  React.ComponentProps<"div">,
  "id"
>) {
  const drag = useSpineDrag({
    id: `step:${id}`,
    phase: "steps",
    kind: "assert",
    disabled,
  });
  return (
    <div {...props} {...drag.rowProps}>
      {drag.handle("Tool was called with…")}
      {children}
    </div>
  );
}

/**
 * The tool picker, moved here verbatim from the form.
 *
 * The free-text fallback matters: a suite with no connected server advertises
 * no tools, and a picker with an empty list would make the route unauthorable
 * on exactly the cases someone is writing from scratch.
 *
 * A catalogue that is still loading, or failed, is not that case: a server
 * owes tools the list does not show. Without a word the bare text box reads
 * as a broken picker, so the row says which, and offers a retry on failure.
 * The input stays usable either way; the notice explains it, never blocks it.
 */
function AddToolRow({
  availableTools,
  toolsStatus,
  onRetryTools,
  onAdd,
}: {
  availableTools: string[];
  toolsStatus?: ToolCatalogStatus;
  onRetryTools?: () => void;
  onAdd: (toolName: string) => void;
}) {
  const [name, setName] = useState("");
  const showFreeText = availableTools.length === 0 || Boolean(toolsStatus);
  return (
    <div className="space-y-2">
      {toolsStatus === "loading" ? (
        <p
          className="flex items-center gap-2 text-[11px] text-muted-foreground"
          data-testid="simple-case-tools-loading"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading tools from the suite's servers…
        </p>
      ) : null}
      {toolsStatus === "error" ? (
        <div
          className="flex flex-wrap items-center gap-2 text-[11px] text-destructive"
          data-testid="simple-case-tools-error"
        >
          <span>
            Couldn't load tools from the suite's servers. Retry, or type the
            exact tool name.
          </span>
          {onRetryTools ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={onRetryTools}
            >
              <RotateCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {availableTools.length > 0 ? (
        <Combobox
          items={availableTools.map((tool) => ({ value: tool, label: tool }))}
          value=""
          onValueChange={(tool) => {
            if (tool) onAdd(tool);
          }}
          placeholder="+ Add tool to this assertion"
          searchPlaceholder="Search tools…"
          emptyMessage="No matching tools"
          className="h-8 w-full justify-between text-xs"
        />
      ) : null}
      {/* A server that owes tools can only be reached by name until it loads. */}
      {showFreeText ? (
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Tool name"
            aria-label="Add a tool"
            className="h-8 flex-1 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => {
              onAdd(name);
              setName("");
            }}
            disabled={!name.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            Add tool
          </Button>
        </div>
      ) : null}
      {/* Only the pattern check: here a name absent from the list is expected,
          it belongs to the server that has not loaded. The region stays in the
          accessibility tree while empty (sr-only, never display: none) so a
          screen reader announces the warning when it appears. */}
      {showFreeText ? (
        <p className="text-[11px] text-warning empty:sr-only" role="status">
          {toolNameWarning(name)}
        </p>
      ) : null}
    </div>
  );
}
