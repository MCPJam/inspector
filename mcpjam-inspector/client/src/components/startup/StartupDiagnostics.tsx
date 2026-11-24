import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { CardFooter } from "@mcpjam/design-system/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@mcpjam/design-system/cn";
import { Textarea } from "@mcpjam/design-system/textarea";
import { copyToClipboard } from "@/lib/clipboard";
import {
  buildStartupDiagnostics,
  diagnosticsRows,
  diagnosticsText,
  probeLocalServer,
  type LocalServerCheck,
  type StartupDiagnostics as Diagnostics,
} from "@/lib/startup-diagnostics";
import type { StartupStatus } from "@/lib/startup-status";

type CopyOutcome = "idle" | "copied" | "failed";

/**
 * The recovery card's footer: Copy diagnostics, and a "Show details"
 * disclosure listing exactly what would be copied. When the clipboard refuses,
 * the details open on a preselected text block so the user can copy it by hand.
 */
export function StartupDiagnostics({ status }: { status: StartupStatus }) {
  const [localServer, setLocalServer] = useState<LocalServerCheck>({
    result: "pending",
  });
  const [copied, setCopied] = useState<CopyOutcome>("idle");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void probeLocalServer().then((check) => {
      if (live) setLocalServer(check);
    });
    return () => {
      live = false;
    };
  }, []);

  const diagnostics = buildStartupDiagnostics({
    stage: status.stage,
    failureKind: status.failureKind,
    localServer,
  });

  const copy = async () => {
    const ok = await copyToClipboard(diagnosticsText(diagnostics));
    setCopied(ok ? "copied" : "failed");
    // Open the details on the text to copy by hand; Hide details still works.
    if (!ok) setOpen(true);
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CardFooter className="flex-col items-stretch gap-3 border-t pt-4 [.border-t]:pt-4">
        <div className="flex items-center justify-between gap-2">
          {/* Wait for the local server check so the copy includes it. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={localServer.result === "pending"}
            onClick={() => void copy()}
          >
            {copied === "copied" ? (
              <Check className="text-success" />
            ) : (
              <Copy />
            )}
            {copied === "copied" ? "Copied" : "Copy diagnostics"}
          </Button>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              {open ? "Hide details" : "Show details"}
              <ChevronDown
                className={cn("transition-transform", open && "rotate-180")}
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        {copied === "copied" && (
          <p role="status" className="text-xs text-muted-foreground">
            Diagnostics copied. Paste them into your message to support.
          </p>
        )}
        {copied === "failed" && (
          <p role="alert" className="text-xs text-destructive">
            Could not copy diagnostics. Select the text below and copy it.
          </p>
        )}
        <CollapsibleContent className="flex flex-col gap-3">
          {copied === "failed" ? (
            <SelectableDiagnostics text={diagnosticsText(diagnostics)} />
          ) : (
            <DiagnosticsList diagnostics={diagnostics} />
          )}
          <p className="text-xs text-muted-foreground">
            Diagnostics leave out emails, tokens, URLs and server names.
          </p>
        </CollapsibleContent>
      </CardFooter>
    </Collapsible>
  );
}

function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostics }) {
  const unreachable =
    diagnostics.localServer.result === "network" ||
    diagnostics.localServer.result === "timeout";
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs"
      data-testid="startup-diagnostics"
    >
      {diagnosticsRows(diagnostics).map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd
            className={cn(
              "min-w-0 break-all font-mono",
              label === "Local server" && unreachable && "text-destructive",
            )}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SelectableDiagnostics({ text }: { text: string }) {
  return (
    <Textarea
      readOnly
      aria-label="Startup diagnostics"
      value={text}
      rows={text.split("\n").length}
      className="resize-none font-mono text-xs"
      ref={(node) => node?.select()}
    />
  );
}
