import { createContext, useContext } from "react";
import { UserRound } from "lucide-react";

/**
 * The account each tool call ran on, by tool call id, for a transcript whose
 * host recorded it (an eval run's trace). Empty everywhere else, so a tool
 * card outside such a transcript shows nothing extra.
 */
export const ToolCallAccountsContext = createContext<
  ReadonlyMap<string, string>
>(new Map());

export function useToolCallAccountName(
  toolCallId: string | undefined,
): string | undefined {
  const names = useContext(ToolCallAccountsContext);
  return toolCallId ? names.get(toolCallId) : undefined;
}

/** The account a tool card's call ran on, beside the tool's name. */
export function ToolCallAccountTag({ name }: { name: string | undefined }) {
  if (!name) return null;
  return (
    <span
      className="inline-flex max-w-40 shrink-0 items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground/80"
      title={`Ran with the ${name} account`}
      data-testid="tool-call-account"
    >
      <UserRound className="size-2.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
