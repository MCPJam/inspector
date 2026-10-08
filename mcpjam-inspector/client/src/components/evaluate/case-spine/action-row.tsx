import { useSpineDrag } from "./spine-drag";
import { InteractCommandField } from "./interact-command";
/**
 * One numbered action, with everything that grades it underneath.
 *
 * The number is the ACTION's ordinal, not the step's offset and not the turn.
 * A click is its own action but shares a turn with the prompt before it, and a
 * check written after that click grades what the click did — numbering it
 * under the prompt would name the wrong thing.
 *
 * Bodies differ by kind on purpose. A prompt stays on screen and stays
 * editable; the last one cannot be removed, because a case has to ask
 * something. A pinned tool call and a recorded interaction are three-field
 * forms that are read far more often than edited, so they collapse to one
 * line and open on click.
 */

import { useMemo, useState, type ReactNode, type Ref } from "react";
import { ChevronRight, MoreHorizontal, Trash2 } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@mcpjam/design-system/popover";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { RemoteServer } from "@/hooks/useProjects";
import type { InteractStep, TestStep } from "@/shared/steps";
import {
  InteractActionFields,
  invokableTools,
  STEP_META,
  StepStatusBadge,
  summarizeStep,
  type AvailableTool,
} from "@/components/evals/step-fields";
import { PinnedToolCallFields } from "@/components/evals/pinned-tool-call-fields";
import type { SpineAction } from "@/shared/steps";

export function ActionRow({
  action,
  total,
  status,
  isActive,
  readOnly,
  availableTools,
  suiteServers,
  projectServers,
  evalValidationBorderClass,
  autoFocus,
  promptRef,
  promptAriaLabel,
  onUpdate,
  onMove,
  onRemove,
  canRemove,
  onHover,
  onSelect,
  defaultOpen = false,
  children,
  newest = false,
  addAfter,
}: {
  action: SpineAction;
  total: number;
  status: EvalStepStatus | undefined;
  isActive: boolean;
  readOnly: boolean;
  availableTools: AvailableTool[];
  suiteServers: string[];
  projectServers?: RemoteServer[];
  evalValidationBorderClass?: string;
  autoFocus?: boolean;
  promptRef?: Ref<HTMLTextAreaElement>;
  promptAriaLabel: string;
  onUpdate: (next: TestStep) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  /** False for the case's last prompt. Every other action can leave. */
  canRemove: boolean;
  onHover?: (stepId: string | null) => void;
  onSelect?: () => void;
  defaultOpen?: boolean;
  children: ReactNode;
  newest?: boolean;
  addAfter?: ReactNode;
}) {
  const step = action.step;
  const meta = STEP_META[step.kind];
  const Icon = meta.Icon;
  const expandable = step.kind !== "prompt";
  const drag = useSpineDrag({
    id: `step:${step.id}`,
    phase: "steps",
    kind: "action",
    disabled: readOnly || !expandable,
  });
  const [open, setOpen] = useState(
    (!readOnly && (step.kind === "interact" || newest)) || defaultOpen,
  );
  const [optionsOpen, setOptionsOpen] = useState(false);
  // An authored tool call names its server by ID, so the row would otherwise
  // read "search-products on p570g76zwcpz1…".
  const serverNamesById = useMemo(
    () =>
      new Map(
        (projectServers ?? []).flatMap((server) =>
          server._id && server.name ? [[server._id, server.name] as const] : [],
        ),
      ),
    [projectServers],
  );

  return (
    <li
      {...drag.rowProps}
      data-testid="spine-action-row"
      data-step-kind={step.kind}
      data-step-id={step.id}
      data-ordinal={action.ordinal}
      onMouseEnter={onHover ? () => onHover(step.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      data-newest={newest || undefined}
      className={cn(
        "group",
        step.kind === "prompt"
          ? "space-y-2"
          : "relative bg-card py-2.5 pl-8 pr-11",
        newest &&
          "relative before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary",
      )}
      data-active={isActive || undefined}
    >
      <div className="flex items-center gap-2">
        {expandable ? (
          drag.handle(step.kind === "toolCall" ? "Call tool" : meta.label)
        ) : (
          <span
            aria-hidden
            className={cn(
              total === 1 && "sr-only",
              "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground",
            )}
          >
            {action.ordinal}
          </span>
        )}
        {!expandable ? (
          <Icon
            className={cn(
              "size-4 shrink-0",
              step.kind === "prompt" ? "text-card-foreground" : meta.tint,
            )}
            aria-hidden="true"
          />
        ) : null}
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`Edit step ${action.ordinal}`}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-ring"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span
              className="min-w-0 text-sm font-semibold leading-[18px] text-card-foreground"
              title={summarizeStep(step, serverNamesById)}
            >
              {step.kind === "toolCall" ? "Call tool" : meta.label}
            </span>
          </button>
        ) : (
          <Label
            htmlFor={`spine-prompt-${step.id}`}
            className="min-w-0 flex-1 text-lg leading-7 font-semibold text-card-foreground"
            onClick={onSelect}
          >
            User prompt
          </Label>
        )}
        {status ? <StepStatusBadge status={status} /> : null}
        {!readOnly && expandable ? (
          <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 size-7 shrink-0"
                aria-label={`Options for step ${action.ordinal}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 space-y-1 p-2">
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start"
                aria-label={`Move step ${action.ordinal} up`}
                disabled={action.ordinal === 1}
                onClick={() => {
                  setOptionsOpen(false);
                  onMove(-1);
                }}
              >
                Move up
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start"
                aria-label={`Move step ${action.ordinal} down`}
                disabled={action.ordinal === total}
                onClick={() => {
                  setOptionsOpen(false);
                  onMove(1);
                }}
              >
                Move down
              </Button>
              {canRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  aria-label={`Remove step ${action.ordinal}`}
                  onClick={() => {
                    setOptionsOpen(false);
                    onRemove();
                  }}
                >
                  Remove
                </Button>
              ) : null}
              {addAfter}
            </PopoverContent>
          </Popover>
        ) : null}
        {readOnly || total === 1 || expandable ? null : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
              aria-label={`Move step ${action.ordinal} up`}
              disabled={action.ordinal === 1}
              onClick={() => onMove(-1)}
            >
              ↑
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
              aria-label={`Move step ${action.ordinal} down`}
              disabled={action.ordinal === total}
              onClick={() => onMove(1)}
            >
              ↓
            </Button>
            {canRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
                aria-label={`Remove step ${action.ordinal}`}
                onClick={onRemove}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </>
        )}
      </div>

      <div className={cn("space-y-5", expandable && "mt-1.5")}>
        {step.kind === "prompt" ? (
          <div className="space-y-2">
            <p
              id={`spine-prompt-help-${step.id}`}
              className="text-sm leading-5 text-secondary-foreground dark:text-muted-foreground"
            >
              The message the user could send the agent.
            </p>
            <Textarea
              ref={promptRef}
              id={`spine-prompt-${step.id}`}
              value={step.prompt}
              onChange={(event) =>
                onUpdate({ ...step, prompt: event.target.value })
              }
              rows={2}
              placeholder="Enter the user prompt…"
              autoFocus={autoFocus}
              aria-label={promptAriaLabel}
              aria-describedby={`spine-prompt-help-${step.id}`}
              readOnly={readOnly}
              className={cn(
                "min-h-[72px] resize-y rounded-lg border-input bg-card px-3.5 py-3 font-sans text-[15px] leading-[22px] text-card-foreground md:text-[15px]",
                !step.prompt.trim() && evalValidationBorderClass,
              )}
            />
          </div>
        ) : null}

        {open && step.kind === "toolCall" ? (
          <PinnedToolCallFields
            seedKey={step.id}
            value={{
              ...(step.serverId ? { serverId: step.serverId } : {}),
              serverName: step.serverName,
              toolName: step.toolName,
              arguments: step.arguments as Record<string, unknown>,
              ...(step.renderTimeoutMs
                ? { renderTimeoutMs: step.renderTimeoutMs }
                : {}),
            }}
            suiteServers={suiteServers}
            projectServers={projectServers}
            availableTools={invokableTools(availableTools)}
            readOnly={readOnly}
            onChange={(cfg) => {
              if (readOnly) return;
              onUpdate({
                ...step,
                serverId:
                  cfg.serverId ??
                  (cfg.serverName === step.serverName
                    ? step.serverId
                    : undefined),
                serverName: cfg.serverName,
                toolName: cfg.toolName,
                arguments: cfg.arguments as Record<string, unknown>,
                renderTimeoutMs: cfg.renderTimeoutMs,
              });
            }}
          />
        ) : null}

        {open && step.kind === "interact" ? (
          <fieldset disabled={readOnly} className="contents">
            <div className="space-y-2">
              <InteractCommandField
                action={step.action}
                onChange={(action) => onUpdate({ ...step, action })}
                readOnly={readOnly}
              />
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Detailed settings</summary>
                <div className="space-y-2 pt-2">
                  <Label htmlFor={`action-view-${step.id}`} className="text-xs">
                    View (tool)
                  </Label>
                  {invokableTools(availableTools).length > 0 ? (
                    <Select
                      value={step.toolName || undefined}
                      disabled={readOnly}
                      onValueChange={(toolName) =>
                        onUpdate({ ...step, toolName })
                      }
                    >
                      <SelectTrigger
                        id={`action-view-${step.id}`}
                        aria-label={`View tool for step ${action.ordinal}`}
                        aria-invalid={!readOnly && !step.toolName.trim()}
                      >
                        <SelectValue placeholder="Pick a view tool…" />
                      </SelectTrigger>
                      <SelectContent>
                        {[
                          ...new Set(
                            invokableTools(availableTools).map(
                              (tool) => tool.name,
                            ),
                          ),
                        ].map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`action-view-${step.id}`}
                      aria-label={`View tool for step ${action.ordinal}`}
                      value={step.toolName}
                      placeholder="View tool name…"
                      readOnly={readOnly}
                      aria-invalid={!readOnly && !step.toolName.trim()}
                      onChange={(event) =>
                        onUpdate({ ...step, toolName: event.target.value })
                      }
                    />
                  )}
                  <InteractActionFields
                    value={(step as InteractStep).action}
                    onChange={(next) => onUpdate({ ...step, action: next })}
                    readOnly={readOnly}
                  />
                </div>
              </details>
            </div>
          </fieldset>
        ) : null}

        {step.kind === "prompt" || readOnly ? (
          children
        ) : (
          <div
            className="relative -ml-8 -mr-11 -mb-2.5 border-t border-border bg-card"
            data-testid="action-following-checks"
          >
            {children}
          </div>
        )}
      </div>
    </li>
  );
}
