import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import type { HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { caniuseTitle } from "./caniuse-coverage";
import { fieldMatchesQuery } from "./support-level";

export function matchesCaniuseQuery(field: HostConfigFieldDef, query: string) {
  return (
    fieldMatchesQuery(field, query) ||
    caniuseTitle(field).toLowerCase().includes(query.trim().toLowerCase())
  );
}

export function CaniuseCapabilitySearch({
  fields,
  query,
  onQueryChange,
  hero = false,
}: {
  fields: readonly HostConfigFieldDef[];
  query: string;
  onQueryChange: (query: string) => void;
  hero?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const label = hero ? "Type a capability" : "Search capabilities";
  const suggestions = fields
    .filter((field) => matchesCaniuseQuery(field, query))
    .slice(0, 12);
  const expanded = open && suggestions.length > 0;
  const currentIndex = Math.min(activeIndex, suggestions.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  useLayoutEffect(() => {
    if (expanded && listRef.current) listRef.current.scrollTop = 0;
  }, [expanded, query]);

  function openSuggestions() {
    setActiveIndex(0);
    setOpen(true);
  }

  function selectSuggestion(field: HostConfigFieldDef) {
    onQueryChange(caniuseTitle(field));
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Enter" && expanded) {
      event.preventDefault();
      selectSuggestion(suggestions[currentIndex]);
    } else if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      suggestions.length > 0
    ) {
      event.preventDefault();
      if (!expanded) {
        openSuggestions();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(currentIndex + step, suggestions.length - 1));
      setActiveIndex(nextIndex);
      document.getElementById(optionId(nextIndex))?.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <div
      className={cn(
        "relative flex w-full flex-col rounded-md",
        hero
          ? "min-w-0 max-w-[13em] shrink grow basis-[9em] bg-transparent"
          : "min-w-28 flex-1 basis-full border border-border bg-background sm:basis-40",
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className={cn("flex items-center gap-2", hero ? "border-b border-primary/40" : "h-9 px-3")}>
        {!hero && <SearchIcon aria-hidden="true" className="size-4 shrink-0 opacity-50" />}
        <input
          type="text"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded ? optionId(currentIndex) : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={hero ? "type a capability…" : "Search capabilities…"}
          className={cn(
            "flex w-full bg-transparent outline-hidden placeholder:text-muted-foreground",
            hero
              ? "pb-1 text-[length:inherit] font-[weight:inherit] leading-[inherit] tracking-[inherit] text-primary"
              : "h-10 rounded-md py-3 text-sm",
          )}
          value={query}
          onFocus={openSuggestions}
          onClick={() => { if (!open) openSuggestions(); }}
          onChange={(event) => {
            onQueryChange(event.target.value);
            openSuggestions();
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        hidden={!expanded}
        className="absolute inset-x-0 top-full z-40 mt-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm font-normal tracking-normal text-popover-foreground shadow-md"
        onMouseDown={(event) => event.preventDefault()}
      >
        {suggestions.map((field, index) => (
          <button
            id={optionId(index)}
            key={field.id}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === currentIndex}
            className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left aria-selected:bg-accent aria-selected:text-accent-foreground"
            onPointerMove={(event) => { if (event.pointerType === "mouse") setActiveIndex(index); }}
            onClick={() => selectSuggestion(field)}
          >
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-semibold">{caniuseTitle(field)}</span>
              <span className="text-[11px] text-muted-foreground">{field.subsection}</span>
            </span>
            {field.description && (
              <span className="text-xs text-muted-foreground">
                {field.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
