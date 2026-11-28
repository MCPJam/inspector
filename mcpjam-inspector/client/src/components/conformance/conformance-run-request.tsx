/**
 * Starting a run from the Conformance page's tabs. The panel builds one
 * request: its "Run conformance checks" button uses it, and it provides it to
 * the content below, so History's empty states can offer "Run new check" for
 * the same run without threading the handler through every caller. Null
 * outside the page: callers hide their run action then.
 */
import { createContext, useContext } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { RUN_LABEL } from "./ConformancePageChrome";

export type ConformanceRunRequest = {
  run: () => void;
  /** A run is going, a server is connecting, or defaults have not loaded. */
  disabled: boolean;
};

export const ConformanceRunRequestContext =
  createContext<ConformanceRunRequest | null>(null);

export function useConformanceRunRequest(): ConformanceRunRequest | null {
  return useContext(ConformanceRunRequestContext);
}

/** The page's "Run conformance checks" button, busy while a run starts. */
export function ConformanceRunButton({
  request,
  running,
  connecting,
}: {
  request: ConformanceRunRequest;
  running: boolean;
  connecting: boolean;
}) {
  return (
    <Button size="sm" onClick={request.run} disabled={request.disabled}>
      {running || connecting ? (
        <>
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          {connecting ? "Connecting..." : "Running..."}
        </>
      ) : (
        RUN_LABEL
      )}
    </Button>
  );
}
