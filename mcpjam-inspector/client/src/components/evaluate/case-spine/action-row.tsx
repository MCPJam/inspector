/**
 * One numbered action, with everything that grades it underneath.
 *
 * The number is the ACTION's ordinal, not the step's offset and not the turn.
 * A click is its own action but shares a turn with the prompt before it, and a
 * check written after that click grades what the click did — numbering it
 * under the prompt would name the wrong thing.
 *
 * Bodies differ by kind on purpose. A prompt is the case, so it is always
 * visible and always editable. A pinned tool call and a recorded interaction
 * are three-field forms that are read far more often than edited, so they
 * collapse to one line and open on click.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
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
  promptAriaLabel,
  onUpdate,
  onMove,
  onRemove,
  onHover,
  onSelect,
  defaultOpen = false,
  children,
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
  promptAriaLabel: string;
  onUpdate: (next: TestStep) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onHover?: (stepId: string | null) => void;
  onSelect?: () => void;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const step = action.step;
  const meta = STEP_META[step.kind];
  const Icon = meta.Icon;
  const expandable = step.kind !== "prompt";
  const [open, setOpen] = useState(defaultOpen);

  return (
    <li
      data-testid="spine-action-row"
      data-step-kind={step.kind}
      data-step-id={step.id}
      data-ordinal={action.ordinal}
      onMouseEnter={onHover ? () => onHover(step.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      className={cn("group space-y-2", isActive && "ring-1 ring-ring")}
    >
      <div className="flex items-center gap-2 py-1">
        <span
          aria-hidden
          className={cn(
            total === 1 && "sr-only",
            "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground",
          )}
        >
          {action.ordinal}
        </span>
        <Icon className={cn("size-4 shrink-0", step.kind === "prompt" ? "text-info" : meta.tint)} />
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`Edit step ${action.ordinal}`}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="min-w-0 truncate text-xs text-foreground">
              {summarizeStep(step)}
            </span>
          </button>
        ) : (
          <Label
            htmlFor={`spine-prompt-${step.id}`}
            className="min-w-0 flex-1 text-lg font-semibold text-info"
            onClick={onSelect}
          >
            User Prompt
          </Label>
        )}
        {status ? <StepStatusBadge status={status} /> : null}
        {readOnly || total === 1 ? null : (
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
            {step.kind !== "prompt" ? (
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

      <div className="space-y-5">
        {step.kind === "prompt" ? (
          <Textarea
            id={`spine-prompt-${step.id}`}
            value={step.prompt}
            onChange={(event) =>
              onUpdate({ ...step, prompt: event.target.value })
            }
            rows={4}
            placeholder="Enter the user prompt…"
            autoFocus={autoFocus}
            aria-label={promptAriaLabel}
            readOnly={readOnly}
            className={cn(
              "resize-none bg-background font-mono text-sm leading-relaxed focus-visible:border-foreground/50 focus-visible:ring-foreground/15",
              !step.prompt.trim() && evalValidationBorderClass,
            )}
          />
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
            <InteractActionFields
              value={(step as InteractStep).action}
              onChange={(next) => onUpdate({ ...step, action: next })}
              readOnly={readOnly}
            />
          </fieldset>
        ) : null}

        {children}
      </div>
    </li>
  );
}
