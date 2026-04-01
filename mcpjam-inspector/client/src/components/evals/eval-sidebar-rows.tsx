import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Parent list row (suite entry or commit group) — matches suite sidebar layout. */
export function EvalSidebarParentRow({
  leftBorderClassName,
  isSelected,
  title,
  subtitle,
  onClick,
  rowTitle,
}: {
  leftBorderClassName: string;
  isSelected: boolean;
  title: ReactNode;
  subtitle: ReactNode;
  onClick: () => void;
  rowTitle?: string;
}) {
  return (
    <div
      className={cn(
        "group flex w-full items-center border-l-2 py-2.5 pl-[15px] pr-4 transition-colors hover:bg-accent/50",
        leftBorderClassName,
        isSelected && "bg-accent shadow-sm",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        title={rowTitle}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center text-left"
      >
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "truncate text-sm font-medium",
              isSelected && "font-semibold",
            )}
          >
            {title}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums">
            {subtitle}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Nested row under an expanded parent (suite variant under a name group, or suite under a commit). */
export function EvalSidebarNestedRow({
  miniBarClassName,
  isSelected,
  selectedClassName,
  rowTitle,
  innerClassName,
  onClick,
  onKeyDown,
  children,
}: {
  miniBarClassName: string;
  isSelected: boolean;
  selectedClassName?: string;
  rowTitle?: string;
  /** Default matches suite nested rows; use e.g. py-2 for two-line commit rows */
  innerClassName?: string;
  onClick: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full items-stretch gap-2 border-b border-border/40 last:border-b-0">
      <div
        className={cn(
          "my-2 ml-2 w-0.5 shrink-0 self-stretch rounded-full",
          miniBarClassName,
        )}
        aria-hidden
      />
      <div
        role="button"
        tabIndex={0}
        title={rowTitle}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          "min-w-0 flex-1 cursor-pointer pl-1 pr-3 text-left transition-colors hover:bg-accent/50",
          innerClassName ?? "py-1.5",
          isSelected && selectedClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
