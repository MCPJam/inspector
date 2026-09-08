/**
 * Persona selector — a real `tablist` with roving tabindex, one tab per
 * persona: pixel-golem avatar, name, sentiment pill.
 */

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { SentimentPill } from "./findings-sentiment-pill";
import type { PersonaFindingsModel } from "./findings-derivation";

export function FindingsPersonaTabs({
  personas,
  selectedIndex,
  onSelect,
}: {
  personas: readonly PersonaFindingsModel[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const focusTab = (index: number) => {
    const tabs =
      listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    tabs?.[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % personas.length;
    else if (event.key === "ArrowLeft") {
      next = (index - 1 + personas.length) % personas.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = personas.length - 1;
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    focusTab(next);
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Personas"
      className="grid grid-cols-[repeat(auto-fit,minmax(224px,1fr))] gap-2"
      data-testid="findings-persona-tabs"
    >
      {personas.map((persona, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={persona.name}
            type="button"
            role="tab"
            id={`findings-persona-tab-${index}`}
            aria-selected={selected}
            aria-controls="findings-persona-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "flex min-h-14 items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5 text-left transition-colors",
              selected
                ? "border-foreground/45 shadow-sm"
                : "border-border hover:border-foreground/25"
            )}
            data-testid="findings-persona-tab"
          >
            <PersonaPixelAvatar
              seed={persona.avatarSeed}
              shapeIndex={persona.avatarShape ?? null}
              paletteIndex={persona.avatarPalette ?? null}
              size="md"
            />
            <span className="min-w-0">
              <span className="mb-1 block truncate text-sm font-semibold text-foreground">
                {persona.name}
              </span>
              <SentimentPill sentiment={persona.sentiment} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
