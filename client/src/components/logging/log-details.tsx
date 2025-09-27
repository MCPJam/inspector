import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import JsonView from "react18-json-view";
import { LogLevelBadge } from "./log-level-badge";
import { Badge } from "@/components/ui/badge";
import { Row } from "@tanstack/react-table";
import { LogEntry } from "@/hooks/use-logger";

interface LogDetailsProps {
  open: boolean;
  setOpen: (value: boolean) => void;
  row: Row<LogEntry>;
}

const LogDetails = ({ open, setOpen, row }: LogDetailsProps) => {
  const details = row.original;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="bg-white">
        <SheetHeader className="pb-0">
          <SheetTitle>
            <span className="flex-1 break-words">{details.message}</span>
          </SheetTitle>
          <SheetDescription>
            <div className="flex gap-2">
              <LogLevelBadge level={details.level} />
              <Badge variant="secondary">{details.context}</Badge>
            </div>

            <div className="text-muted-foreground font-mono text-xs mt-2">
              {new Date(details.timestamp).toLocaleString("en-US", {
                month: "short",
                day: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </div>
          </SheetDescription>
        </SheetHeader>
        <div className="border-t bg-muted/20 p-4 space-y-3">
          {details.data !== undefined && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                DATA:
              </div>
              <div className="text-xs bg-background border rounded overflow-scroll max-h-[70vh] p-2">
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
        <SheetFooter>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

export default LogDetails;
