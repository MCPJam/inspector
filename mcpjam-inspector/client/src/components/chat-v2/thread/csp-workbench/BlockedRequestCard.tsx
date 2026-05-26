import { useState } from "react";
import { ChevronRight, Copy, Check, ExternalLink } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";
import type { Diagnosis } from "./types";

interface BlockedRequestCardProps {
  diagnosis: Diagnosis;
  index: number;
  defaultOpen?: boolean;
  /** Cross-link to Policy Diff scrolled to the diagnosis' origin. */
  onViewPolicyDiff?: (host: string) => void;
}

function pillClasses(klass: Diagnosis["class"]): string {
  switch (klass) {
    case "csp":
      return "bg-destructive/10 text-destructive";
    case "cors":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "host-stripped":
      return "bg-purple-500/10 text-purple-600 dark:text-purple-400";
    case "runtime-mismatch":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "network":
      return "bg-muted text-muted-foreground";
    case "sandbox":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
  }
}

function pillLabel(klass: Diagnosis["class"]): string {
  switch (klass) {
    case "host-stripped":
      return "HOST-STRIPPED";
    case "runtime-mismatch":
      return "MISMATCH";
    default:
      return klass.toUpperCase();
  }
}

function formatPatchText(diagnosis: Diagnosis): string {
  if (!diagnosis.patch) return "";
  const { field, add } = diagnosis.patch;
  const value = JSON.stringify(add);
  return `csp: {\n  ${field}: ${value},\n}`;
}

function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function BlockedRequestCard({
  diagnosis,
  index,
  defaultOpen = false,
  onViewPolicyDiff,
}: BlockedRequestCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const isHostStripped = diagnosis.class === "host-stripped";
  const isRuntimeMismatch = diagnosis.class === "runtime-mismatch";
  const showPatch = diagnosis.patch !== null;
  const copyLabel = isHostStripped ? "Copy declaration" : "Copy patch";

  const handleCopy = async () => {
    const text = formatPatchText(diagnosis);
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      toast.success(
        isHostStripped
          ? "Declaration copied — portability intent only"
          : "Patch copied",
      );
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Could not copy to clipboard");
    }
  };

  const handlePreviewHypothesis = () => {
    toast(
      "Hypothesis preview recorded · re-run flow coming soon",
      { duration: 2200 },
    );
  };

  return (
    <div className="rounded-md border border-border/40 bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`bcard-body-${index}`}
        className="w-full grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
      >
        <span className="font-mono text-[10px] text-muted-foreground/60 w-6">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          className={`inline-flex items-center px-2 h-5 rounded font-mono text-[10px] font-medium ${pillClasses(
            diagnosis.class,
          )}`}
        >
          {pillLabel(diagnosis.class)}
        </span>
        <span className="font-mono text-[11.5px] text-foreground truncate min-w-0">
          {diagnosis.url}
        </span>
        <ChevronRight
          aria-hidden
          className={`size-3.5 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          } motion-reduce:transition-none`}
        />
      </button>

      {open && (
        <div
          id={`bcard-body-${index}`}
          className="border-t border-border/40 bg-muted/15 px-3 pt-2 pb-3 space-y-3"
        >
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-[11.5px]">
            <dt className="text-muted-foreground">why</dt>
            <dd>{diagnosis.why}</dd>

            <dt className="text-muted-foreground">browser</dt>
            <dd className="font-mono text-foreground/80 break-words">
              {diagnosis.browserMessage}
            </dd>

            <dt className="text-muted-foreground">evidence</dt>
            <dd className="font-mono text-[10.5px] text-muted-foreground">
              <span className="inline-block px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 mr-1.5">
                {diagnosis.primarySource}
              </span>
              {diagnosis.evidence.length > 1
                ? `+${diagnosis.evidence.length - 1} more`
                : null}
            </dd>

            {diagnosis.patch && (
              <>
                <dt className="text-muted-foreground">
                  {isHostStripped ? "field (declaration)" : "field to change"}
                </dt>
                <dd>
                  <span className="inline-block font-mono text-[11px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
                    _meta.ui.csp.{diagnosis.patch.field}
                  </span>
                </dd>
              </>
            )}
          </dl>

          {isHostStripped && diagnosis.patch && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-relaxed">
              <strong className="font-medium">
                Adding this won&apos;t fix the current run.
              </strong>{" "}
              The host stripped this entry before the browser ever received
              the policy. Copy the declaration to document your portability
              intent — and consider self-hosting the resource for this host.
            </div>
          )}

          {isRuntimeMismatch && (
            <div className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11.5px] leading-relaxed">
              <strong className="font-medium">effective ≠ observed.</strong>{" "}
              The host reported this origin as allowed, but the browser still
              blocked it. Possible causes: runtime restriction layered on top
              of the iframe, browser/extension policy, or
              evidence-collection lag. Adding to{" "}
              <span className="font-mono">_meta.ui.csp</span> will not help —
              investigate the host runtime or compare snapshots in Policy
              Diff.
            </div>
          )}

          {diagnosis.class === "cors" && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-relaxed">
              This is a <strong className="font-medium">fetch / XHR CORS block</strong>,
              not a CSP block. The remote origin must return an{" "}
              <span className="font-mono">Access-Control-Allow-Origin</span>{" "}
              header, or proxy the request through a server you control.
            </div>
          )}

          {showPatch && (
            <pre className="rounded-md border border-border/40 bg-background px-3 py-2 font-mono text-[11.5px] leading-relaxed overflow-x-auto">
              <span className="text-muted-foreground">{`csp: {`}</span>
              {"\n"}
              <span className="block -mx-3 px-3 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                {`+   ${diagnosis.patch!.field}: ${JSON.stringify(diagnosis.patch!.add)},`}
              </span>
              <span className="text-muted-foreground">{`}`}</span>
            </pre>
          )}

          {diagnosis.risks.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {diagnosis.risks.map((r) => (
                <span
                  key={r}
                  className={`inline-block font-mono text-[10px] px-1.5 py-0.5 rounded ${
                    r === "nested iframe" || r === "http:"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {r}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="flex-1" />
            {(isHostStripped || isRuntimeMismatch) && onViewPolicyDiff && (
              <button
                type="button"
                className="inline-flex items-center gap-1 px-2 h-7 rounded text-[11px] text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onViewPolicyDiff(originOf(diagnosis.url))}
              >
                View policy diff <ExternalLink className="size-3" />
              </button>
            )}
            {diagnosis.class !== "cors" && diagnosis.class !== "runtime-mismatch" && (
              <button
                type="button"
                title="Coming soon"
                onClick={handlePreviewHypothesis}
                className="inline-flex items-center gap-1 px-2.5 h-7 rounded border border-border/60 text-[11px] text-muted-foreground hover:text-foreground hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Preview hypothesis
              </button>
            )}
            {showPatch && (
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded bg-foreground text-background text-[11px] font-medium hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied ? (
                  <>
                    <Check className="size-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" /> {copyLabel}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
