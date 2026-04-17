import { useState } from "react";
import { AlertTriangle, CheckCircle2, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import type { XAADecodedJwt } from "@/lib/xaa/types";
import type { NegativeTestMode } from "@/shared/xaa.js";
import { NEGATIVE_TEST_MODE_DETAILS } from "@/shared/xaa.js";
import { copyToClipboard } from "@/lib/clipboard";

interface IdJagInspectorProps {
  rawJwt: string;
  decoded: XAADecodedJwt;
  negativeTestMode: NegativeTestMode;
}

export function IdJagInspector({
  rawJwt,
  decoded,
  negativeTestMode,
}: IdJagInspectorProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(rawJwt);
    if (!success) {
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="bg-background border border-border rounded-lg shadow-sm p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">ID-JAG Inspector</h3>
            <Badge variant="secondary" className="text-[10px]">
              {NEGATIVE_TEST_MODE_DETAILS[negativeTestMode].label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Decode the assertion before sending it to the authorization server.
            Broken claims are called out explicitly below.
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={handleCopy}>
          <Copy className="h-3.5 w-3.5 mr-1" />
          {copied ? "Copied" : "Copy JWT"}
        </Button>
      </div>

      <div className="grid gap-2">
        {decoded.issues.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-md px-3 py-2">
            <CheckCircle2 className="h-4 w-4" />
            No structural issues detected in the decoded ID-JAG.
          </div>
        ) : (
          decoded.issues.map((issue) => (
            <div
              key={`${issue.section}-${issue.field}`}
              className="border border-red-300 dark:border-red-900 rounded-md bg-red-50 dark:bg-red-950/20 px-3 py-2"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300">
                <AlertTriangle className="h-4 w-4" />
                {issue.label}
              </div>
              <div className="mt-1 text-xs text-red-700/90 dark:text-red-300/90">
                Expected: {issue.expected}
              </div>
              <div className="text-xs text-red-700/90 dark:text-red-300/90">
                Actual: {issue.actual}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Header
          </div>
          <ScrollableJsonView
            value={decoded.header ?? { error: "Header could not be decoded" }}
            containerClassName="rounded-sm bg-muted/20 p-2 max-h-[280px]"
          />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Payload
          </div>
          <ScrollableJsonView
            value={decoded.payload ?? { error: "Payload could not be decoded" }}
            containerClassName="rounded-sm bg-muted/20 p-2 max-h-[280px]"
          />
        </div>
      </div>

      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Signature
        </div>
        <div className="rounded-sm bg-muted/20 p-2 text-[11px] font-mono break-all text-muted-foreground">
          {decoded.signature || "(missing)"}
        </div>
      </div>
    </div>
  );
}
