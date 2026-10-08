import { MoreHorizontal, Plus, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@mcpjam/design-system/cn";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@mcpjam/design-system/dropdown-menu";
import { ROUTE_CHECK_LABELS } from "@/components/evals/eval-add-catalog";
import type { SimpleCaseTool } from "../simple-case/simple-case-model";
import { SpineDragProvider, useSpineDrag } from "./spine-drag";

/** The existing route matcher, presented as explicit assertions. */
export function RouteCheckRow({
  kind,
  tools,
  newest,
  onRemove,
  onAddTool,
  onToolChange,
  onToolRemove,
  onReorder,
}: {
  kind: keyof typeof ROUTE_CHECK_LABELS;
  tools: SimpleCaseTool[];
  newest: boolean;
  onRemove: () => void;
  onAddTool: () => void;
  onToolChange: (id: string, toolName: string) => void;
  onToolRemove: (id: string) => void;
  onReorder: (from: string, to: string) => void;
}) {
  const label = ROUTE_CHECK_LABELS[kind];
  return (
    <li
      data-testid={`route-check-${kind}`}
      data-newest={newest || undefined}
      data-role="required"
      className={cn(
        "relative bg-card py-2.5 pl-8 pr-11",
        newest &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary",
      )}
    >
      <div className="space-y-1.5">
        <p className="text-[13px] font-semibold leading-[18px] text-card-foreground">
          {label}
        </p>
        <p className="text-[13px] leading-[18px] text-secondary-foreground dark:text-muted-foreground">
          {kind === "noTools"
            ? "Passes when the agent makes no tool calls."
            : "Calls must follow this order, with no extra calls. Edit arguments in each tool’s check."}
        </p>
        {kind === "exactOrder" && (
          <SpineDragProvider
            disabled={false}
            items={tools.map((tool) => `sequence:${tool.id}`)}
            onReorder={({ active, over }) => {
              if (over && active.id !== over.id)
                onReorder(String(active.id).slice(9), String(over.id).slice(9));
            }}
          >
            <ol
              aria-label="Expected tool call order"
              className="divide-y divide-border rounded-md border border-input"
            >
              {tools.map((tool, index) => (
                <SequenceTool
                  key={tool.id}
                  tool={tool}
                  index={index}
                  canRemove={tools.length > 1}
                  onChange={(name) => onToolChange(tool.id!, name)}
                  onRemove={() => onToolRemove(tool.id!)}
                />
              ))}
            </ol>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={onAddTool}
            >
              <Plus className="size-3" />
              Add a tool
            </Button>
          </SpineDragProvider>
        )}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-secondary-foreground dark:text-muted-foreground">
          Required
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Options for ${label}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRemove}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function SequenceTool({
  tool,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  tool: SimpleCaseTool;
  index: number;
  canRemove: boolean;
  onChange: (name: string) => void;
  onRemove: () => void;
}) {
  const drag = useSpineDrag({
    id: `sequence:${tool.id}`,
    phase: "case",
    kind: "assert",
  });
  return (
    <li
      {...drag.rowProps}
      className="relative flex items-center gap-2 bg-card py-2 pl-8 pr-2"
    >
      {drag.handle(`expected tool ${index + 1}`)}
      <span className="text-xs text-muted-foreground">{index + 1}.</span>
      <Input
        aria-label={`Expected tool ${index + 1}`}
        value={tool.toolName}
        placeholder="Tool name…"
        className="h-7 text-xs"
        aria-invalid={!tool.toolName.trim()}
        onChange={(event) => onChange(event.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        disabled={!canRemove}
        aria-label={`Remove expected tool ${index + 1}`}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </li>
  );
}
