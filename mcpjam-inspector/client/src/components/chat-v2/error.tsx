import { CircleAlert, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";

interface ErrorBoxProps {
  message: string;
  errorDetails?: string;
  onResetChat: () => void;
}

const parseErrorDetails = (details: string | undefined) => {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details);
    return parsed;
  } catch {
    return null;
  }
};

export function ErrorBox({
  message,
  errorDetails,
  onResetChat,
}: ErrorBoxProps) {
  const [isErrorDetailsOpen, setIsErrorDetailsOpen] = useState(false);
  const errorDetailsJson = parseErrorDetails(errorDetails);

  return (
    <div className="flex flex-col gap-3 border border-red-500 rounded bg-red-300/80 p-4 text-red-900">
      <div className="flex items-center gap-3">
        <CircleAlert className="h-6 w-6 text-red-900 flex-shrink-0" />
        <p className="flex-1 text-sm leading-6">An error occured: {message}</p>
        <Button
          type="button"
          variant="outline"
          onClick={onResetChat}
          className="ml-auto flex-shrink-0"
        >
          Reset chat
        </Button>
      </div>
      {errorDetails && (
        <Collapsible
          open={isErrorDetailsOpen}
          onOpenChange={setIsErrorDetailsOpen}
        >
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-red-700 hover:text-red-800 transition-colors">
            <span>More details</span>
            {isErrorDetailsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="rounded border border-red-500/30 bg-background/50 p-2">
              {errorDetailsJson ? (
                <JsonView
                  src={errorDetailsJson}
                  style={{
                    backgroundColor: "transparent",
                    fontSize: "11px",
                  }}
                />
              ) : (
                <pre className="text-xs font-mono text-red-700 whitespace-pre-wrap overflow-x-auto">
                  {errorDetails}
                </pre>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
