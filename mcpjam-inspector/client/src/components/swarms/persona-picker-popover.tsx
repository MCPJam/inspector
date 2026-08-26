/**
 * "Add existing personas" — the popover that lets a swarm pull in personas the
 * project already has.
 *
 * One component for both call sites in the create flow (BB-122/123). Describe
 * and Confirm shipped it as two near-identical 40-line bodies, which is exactly
 * how a persona row starts reading differently in two places that are supposed
 * to be the same list.
 *
 * The two sites do NOT have the same semantics, though, so that difference is
 * the prop rather than something the component papers over:
 *
 *  - Describe offers the whole library as a CHECKLIST — the picker is where you
 *    both attach and detach, so its rows are `role="checkbox"` and carry their
 *    selected state.
 *  - Confirm offers only what is not already attached, as an ADD list —
 *    detaching there is the card's own Remove button, so a checkbox that could
 *    never be unchecked from inside the popover would be a lie.
 */
import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { cn } from "@/lib/utils";

/** The persona fields this picker draws. */
export type PersonaPickerOption = {
  _id: string;
  name: string;
  role: string;
  avatarShape?: number;
  avatarPalette?: number;
};

export type PersonaPickerMode =
  /** Attach and detach from inside the list. */
  | {
      kind: "toggle";
      selectedIds: readonly string[];
      onToggle: (personaId: string) => void;
    }
  /** Attach only; the caller has already filtered out what is attached. */
  | { kind: "add"; onAdd: (personaId: string) => void };

export function PersonaPickerPopover({
  personas,
  open,
  onOpenChange,
  mode,
  groupLabel,
  triggerLabel = "Add existing personas",
  triggerSize,
  triggerClassName,
  triggerTestId,
  listTestId,
}: {
  personas: readonly PersonaPickerOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: PersonaPickerMode;
  /** Names the list for assistive tech; the two sites describe it differently. */
  groupLabel: string;
  triggerLabel?: string;
  triggerSize?: "sm";
  triggerClassName?: string;
  triggerTestId?: string;
  listTestId?: string;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size={triggerSize}
          className={triggerClassName}
          data-testid={triggerTestId}
        >
          <Plus className="mr-1.5 size-4" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <div
          role="group"
          aria-label={groupLabel}
          className="max-h-72 space-y-0.5 overflow-y-auto"
          data-testid={listTestId}
        >
          {personas.map((persona) => {
            const selected =
              mode.kind === "toggle" && mode.selectedIds.includes(persona._id);
            return (
              <button
                key={persona._id}
                type="button"
                // Checkbox only where the row can actually be unchecked.
                role={mode.kind === "toggle" ? "checkbox" : undefined}
                aria-checked={mode.kind === "toggle" ? selected : undefined}
                aria-label={
                  mode.kind === "toggle"
                    ? `Include ${persona.name}`
                    : `Add ${persona.name}`
                }
                onClick={() =>
                  mode.kind === "toggle"
                    ? mode.onToggle(persona._id)
                    : mode.onAdd(persona._id)
                }
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  selected
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60"
                )}
              >
                <PersonaPixelAvatar
                  seed={persona._id}
                  shapeIndex={persona.avatarShape}
                  paletteIndex={persona.avatarPalette}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">
                    {persona.name}
                  </span>
                  {persona.role ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {persona.role}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
