import JsonView from "react18-json-view";
import { Row } from "@tanstack/react-table";
import { LogEntry } from "@/hooks/use-logger";

interface LogDetailsProps {
  row: Row<LogEntry>;
}

const LogDetails = ({ row }: LogDetailsProps) => {
  const details = row.original;

  return (
    <div>
      {details.data !== undefined && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-2">
            DATA:
          </div>
          <div className="text-xs bg-background border rounded overflow-scroll max-h-[50vh] p-2">
            <JsonView
              src={details.data as object}
              dark={true}
              theme="atom"
              enableClipboard={true}
              displaySize={false}
              collapseStringsAfterLength={100}
              style={{
                fontSize: "12px",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                backgroundColor: "hsl(var(--background))",
                padding: "0",
                borderRadius: "0",
                border: "none",
              }}
            />
          </div>
        </div>
      )}

      {details.error && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1">
            ERROR:
          </div>
          <pre className="text-xs bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded p-2 overflow-auto max-h-40 text-red-700 dark:text-red-400">
            {details.error.message}
            {details.error.stack && `\n\n${details.error.stack}`}
          </pre>
        </div>
      )}
    </div>
  );
};

export default LogDetails;
