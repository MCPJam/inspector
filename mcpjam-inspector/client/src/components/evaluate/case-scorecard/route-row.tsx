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
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { ToolCalledWithFields } from "@/components/evals/checks-section";
import { RoleChip } from "@/components/evals/scorer-role-control";
import { UNSET_TOOLS_BLOCK_REASON } from "../simple-case/simple-case-model";
import type {
  CaseKind,
  SimpleCaseTool,
} from "../simple-case/simple-case-model";
import { StatusDot, overlayStatus, type SimpleCaseOverlay } from "../simple-case/status-dot";
import { ProvenanceChip } from "./provenance-chip";
import { RowMarker } from "./row-marker";
import type { ScorecardRow } from "./case-scorecard-model";

export function RouteRow({
  row,
  availableTools,
  readOnly,
  overlay,
  showUnsetError,
  negativeContradiction,
  onSetTools,
  onChooseNoTool,
  onChooseTools,
  onAddTool,
  onSetKind,
}: {
  row: ScorecardRow;
  availableTools?: string[];
  readOnly: boolean;
  overlay?: SimpleCaseOverlay | null;
  showUnsetError: boolean;
  negativeContradiction: boolean;
  onSetTools: (tools: SimpleCaseTool[]) => void;
  onChooseNoTool: () => void;
  onChooseTools: () => void;
  onAddTool: (toolName: string) => void;
  onSetKind: (kind: CaseKind) => void;
}) {
  const route = row.route;
  if (!route) return null;
  const locked = route.kind === "locked" || readOnly;
  const tools =
    route.kind === "tools" || route.kind === "locked" ? route.tools : [];
  const matchMode: CaseKind = route.kind === "tools" ? route.matchMode : "capability";

  return (
    <li
      data-testid="case-route-row"
      data-row-key={row.key}
      data-route={route.kind}
      data-role={row.role}
      className="space-y-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <RowMarker row={row} />
        <ProvenanceChip provenance="route" />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={row.tooltip}>
          {row.label}
        </span>
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
            <ToggleGroupItem value="capability" className="h-6 px-2 text-[11px]">
              Reach the tool
            </ToggleGroupItem>
            <ToggleGroupItem value="regression" className="h-6 px-2 text-[11px]">
              Exact route
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        <RoleChip role={row.role} />
      </div>

      {route.kind === "tools" && matchMode === "regression" ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Strict order, no extra calls; arguments compared as pinned.
        </p>
      ) : null}

      {route.kind === "locked" ? (
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

      {showUnsetError ? (
        <p
          className="text-[11px] text-destructive"
          data-testid="simple-case-tools-unset"
        >
          {UNSET_TOOLS_BLOCK_REASON}
        </p>
      ) : null}

      {negativeContradiction ? (
        <p
          className="text-[11px] text-destructive"
          data-testid="simple-case-negative-contradiction"
        >
          This case says no tool should be called, but a check that requires a
          tool call still applies — from the suite, this case, or a step. Those
          cannot both hold.
        </p>
      ) : null}

      {route.kind !== "noTool" ? (
        <div className="space-y-2">
          {tools.map((tool, index) => (
            <div
              key={tool.id}
              className="space-y-2 rounded-md border border-border bg-muted/20 p-2.5"
              data-testid="simple-case-tool-row"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {matchMode === "regression" ? `Step ${index + 1}` : "Tool"}
                </p>
                <div className="flex items-center gap-1">
                  <StatusDot status={overlayStatus(overlay, tool.id)} />
                  {locked ? null : (
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
                predicate={{
                  type: "toolCalledWith",
                  toolName: tool.toolName,
                  args: {
                    args: matchMode === "regression" ? tool.arguments : {},
                  },
                }}
                onChange={(next) => {
                  if (next.type !== "toolCalledWith") return;
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
                readOnly={locked}
              />
            </div>
          ))}
          {locked ? null : (
            <AddToolRow
              availableTools={availableTools ?? []}
              onAdd={onAddTool}
            />
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The tool picker, moved here verbatim from the form.
 *
 * The free-text fallback matters: a suite with no connected server advertises
 * no tools, and a picker with an empty list would make the route unauthorable
 * on exactly the cases someone is writing from scratch.
 */
function AddToolRow({
  availableTools,
  onAdd,
}: {
  availableTools: string[];
  onAdd: (toolName: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-2">
      {availableTools.length > 0 ? (
        <select
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Add a tool"
        >
          <option value="">Pick a tool…</option>
          {availableTools.map((tool) => (
            <option key={tool} value={tool}>
              {tool}
            </option>
          ))}
        </select>
      ) : (
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Tool name"
          aria-label="Add a tool"
          className="h-8 flex-1 text-xs"
        />
      )}
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
        Add
      </Button>
    </div>
  );
}
