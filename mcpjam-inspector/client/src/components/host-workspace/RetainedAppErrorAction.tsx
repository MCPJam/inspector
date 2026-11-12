import { Button } from "@mcpjam/design-system/button";
import type { AppRow } from "./ThreadAppPanel";

/**
 * The action under a retained App's error. A row that can be retried gets
 * Retry, and a row whose close failed gets Retry close. An inline row that
 * can't be retried (its tool approval was denied, say) gets Close, because an
 * inline App has no header of its own to close it from.
 */
export function RetainedAppErrorAction({
  row,
  inline,
  close,
  retry,
}: {
  row: AppRow;
  inline: boolean;
  close: (row: AppRow) => Promise<void>;
  retry: (
    server: AppRow["server"],
    declaration: AppRow["declaration"],
  ) => Promise<void>;
}) {
  const closes = !!row.closing || (inline && row.retryable === false);
  if (row.retryable === false && !closes) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        closes ? void close(row) : void retry(row.server, row.declaration)
      }
    >
      {row.closing ? "Retry close" : closes ? "Close" : "Retry"}
    </Button>
  );
}
