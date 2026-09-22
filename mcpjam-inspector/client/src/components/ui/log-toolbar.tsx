import type { ReactNode } from "react";
import { Copy, PanelRightClose, Search } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";

/**
 * Search / count / copy / close chrome for a log rail.
 *
 * Filtering and export stay with the caller — JSON-RPC traffic and WebMCP
 * activity are different stores. Pass extra controls through `leading` (left of
 * copy) and `actions` (export, clear, …).
 */
export function LogToolbar({
  searchQuery,
  onSearchQueryChange,
  searchVisible = true,
  filteredCount,
  totalCount,
  onCopy,
  copyDisabled,
  onClose,
  closeTitle,
  leading,
  actions,
}: {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchVisible?: boolean;
  filteredCount: number;
  totalCount: number;
  onCopy?: () => void;
  copyDisabled?: boolean;
  onClose?: () => void;
  closeTitle?: string;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="@container/logger-toolbar flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
      {searchVisible ? (
        <>
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search logs"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <span className="hidden whitespace-nowrap text-xs text-muted-foreground @min-[400px]/logger-toolbar:inline-block">
            {filteredCount} / {totalCount}
          </span>
          {leading}
        </>
      ) : (
        <div className="flex-1" />
      )}
      {onCopy ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onCopy}
          disabled={copyDisabled}
          className="hidden h-7 w-7 shrink-0 @min-[300px]/logger-toolbar:inline-flex"
          title="Copy logs to clipboard"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      {actions}
      {onClose ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-7 w-7 flex-shrink-0"
          title={closeTitle}
          aria-label={closeTitle}
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
