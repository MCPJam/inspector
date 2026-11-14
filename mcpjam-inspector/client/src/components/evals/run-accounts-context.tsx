import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { useEvalAccountSelectionEnabled } from "@/hooks/useEvalAccountSelectionEnabled";
import {
  spanAccountName,
  toolCallAccountNames,
} from "@/lib/evals/eval-run-accounts";
import { ToolCallAccountsContext } from "@/components/chat-v2/thread/tool-call-account";
import type { EvalRunAccount } from "./types";

/**
 * The accounts a run recorded, for the trace of one of its iterations.
 *
 * Context, not props: the trace's tool calls render several components below
 * the run (the iteration sheet, the trace viewer, the transcript, each tool
 * card), and none of the layers between has any other use for the run.
 */
const RunAccountsContext = createContext<readonly EvalRunAccount[] | undefined>(
  undefined,
);

/** Names each tool call's account in the traces below, while the rollout flag is on. */
export function RunAccountsProvider({
  accounts,
  children,
}: {
  accounts: readonly EvalRunAccount[] | undefined;
  children: ReactNode;
}) {
  const enabled = useEvalAccountSelectionEnabled();
  return (
    <RunAccountsContext.Provider value={enabled ? accounts : undefined}>
      {children}
    </RunAccountsContext.Provider>
  );
}

/** The account a tool span ran on, for the trace timeline's row label. */
export function useSpanAccountName(): (
  span: Pick<EvalTraceSpan, "category" | "connectionId" | "serverId">,
) => string | undefined {
  const accounts = useContext(RunAccountsContext);
  return useCallback((span) => spanAccountName(span, accounts), [accounts]);
}

/**
 * Each tool call's account by tool call id, for the transcript's tool cards,
 * which know their call but not its span.
 */
export function TraceToolCallAccounts({
  spans,
  children,
}: {
  spans: readonly EvalTraceSpan[] | undefined;
  children: ReactNode;
}) {
  const accounts = useContext(RunAccountsContext);
  const names = useMemo(
    () => toolCallAccountNames(spans, accounts),
    [spans, accounts],
  );
  return (
    <ToolCallAccountsContext.Provider value={names}>
      {children}
    </ToolCallAccountsContext.Provider>
  );
}
