/**
 * The evidence disclosure — "what supports that?", one click away.
 *
 * NOT a prompt viewer. What renders here is the bounded, scrubbed excerpt the
 * producer stored plus the identity of the iteration or session it came from.
 * The internal analysis prompt is never part of the customer payload and has
 * no affordance here by design.
 *
 * Navigation goes through a TYPED locator. A caller receives
 * `{ kind: "iteration", id }` or `{ kind: "session", id }` and routes it with
 * its own knowledge of its own routes — the panel never inspects the shape of
 * an id to guess which one it is, which is how an eval iteration used to get
 * handed to a session callback.
 */
import { ExternalLink } from "lucide-react";
import type { ActionableFindingEvidence } from "@/lib/insights-envelope-api";
import { EVIDENCE_KIND_LABEL } from "./finding-provenance";

export type FindingEvidenceLocator =
  | { kind: "iteration"; id: string }
  | { kind: "session"; id: string };

export function locatorFor(
  evidence: ActionableFindingEvidence,
): FindingEvidenceLocator | null {
  if (evidence.iterationId) {
    return { kind: "iteration", id: evidence.iterationId };
  }
  if (evidence.sessionId) return { kind: "session", id: evidence.sessionId };
  return null;
}

/** Show the MCP result text first; the exact recorded wrapper remains available. */
function readableResult(excerpt: string): string | null {
  const resultStart = excerpt.indexOf("Result: ");
  if (resultStart < 0) return null;
  const argsStart = excerpt.lastIndexOf("Arguments: ");
  const json = excerpt
    .slice(resultStart + 8, argsStart > resultStart ? argsStart : undefined)
    .trim();
  try {
    const result: unknown = JSON.parse(json);
    if (
      !result ||
      typeof result !== "object" ||
      !("content" in result) ||
      !Array.isArray(result.content)
    )
      return null;
    const text = result.content
      .filter(
        (part): part is { type: string; text: string } =>
          part !== null &&
          typeof part === "object" &&
          part.type === "text" &&
          typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n\n");
    return text || null;
  } catch {
    return null;
  }
}

export function FindingEvidenceList({
  evidence,
  onOpenEvidence,
  variant = "card",
}: {
  evidence: readonly ActionableFindingEvidence[];
  /** Absent ⇒ the rows render without a link rather than with a dead one. */
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  variant?: "card" | "drawer";
}) {
  if (evidence.length === 0) {
    return (
      <p
        className="text-[12px] text-muted-foreground"
        data-testid="finding-evidence-empty"
      >
        No excerpt was recorded for this finding. The counts above still hold —
        they come from the contract chain, not from this text.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid="finding-evidence-list">
      {evidence.map((row, index) => {
        const locator = locatorFor(row);
        const contrast = row.kind === "contrast";
        const preview =
          variant === "drawer" ? readableResult(row.excerpt) : null;
        return (
          <li
            key={`${row.iterationId ?? row.sessionId ?? "e"}-${index}`}
            className={
              variant === "drawer"
                ? `border-l-2 py-1 pl-4 ${
                    contrast ? "border-success" : "border-destructive"
                  }`
                : "rounded-md border border-border/50 bg-background/60 px-2.5 py-2"
            }
            data-testid="finding-evidence"
            data-evidence-kind={row.kind}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={
                  contrast
                    ? "text-[11px] font-medium text-muted-foreground"
                    : "text-[11px] font-medium text-foreground/80"
                }
              >
                {EVIDENCE_KIND_LABEL[row.kind]}
              </span>
              {row.toolName ? (
                <code className="rounded bg-muted px-1 py-0 font-code text-[11px] text-muted-foreground">
                  {row.toolName}
                </code>
              ) : null}
              {row.errorCode ? (
                <code className="rounded bg-muted px-1 py-0 font-code text-[11px] text-muted-foreground">
                  {row.errorCode}
                </code>
              ) : null}
              {locator && onOpenEvidence ? (
                <button
                  type="button"
                  className="ml-auto inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => onOpenEvidence(locator)}
                  data-testid="finding-evidence-open"
                  data-locator-kind={locator.kind}
                >
                  <ExternalLink className="size-3" aria-hidden="true" />
                  Open {locator.kind}
                </button>
              ) : null}
            </div>
            {/* Untrusted, server-authored text. Rendered as data: no markdown,
                no links made from it, and wrapped so a long line cannot push
                the panel sideways. */}
            <p
              className={
                variant === "drawer"
                  ? "mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--code-bg)] p-3 font-code text-xs leading-relaxed text-[var(--code-text)]"
                  : "mt-1 break-words text-[12px] leading-relaxed text-muted-foreground"
              }
            >
              {preview ?? row.excerpt}
            </p>
            {preview ? (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer py-1">
                  Full recorded excerpt
                </summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-code text-xs">
                  {row.excerpt}
                </pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
