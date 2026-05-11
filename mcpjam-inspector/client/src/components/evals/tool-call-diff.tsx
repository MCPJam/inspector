import type { EvalToolCallMatchResult } from "@/shared/eval-matching";

type ToolCallDiffProps = {
  result: EvalToolCallMatchResult;
  /**
   * When provided, used to surface call indices for outOfOrder entries.
   * Layout-only; not required for correctness.
   */
  expectedToolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  actualToolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
};

/**
 * Categorized expected-vs-actual diff. Shown above the raw Expected/Actual
 * panels when a positive test failed (or when extras/out-of-order are
 * worth surfacing even on passes). Skips sections that are empty so the
 * component shrinks to nothing for a clean pass.
 */
export function ToolCallDiff({
  result,
  expectedToolCalls,
  actualToolCalls,
}: ToolCallDiffProps) {
  const { missing, extra, outOfOrder, argumentMismatches } = result;
  const hasAnything =
    missing.length > 0 ||
    extra.length > 0 ||
    outOfOrder.length > 0 ||
    argumentMismatches.length > 0;
  if (!hasAnything) return null;

  return (
    <div
      role="region"
      aria-label="Tool-call diff"
      className="space-y-2 rounded-md border border-border/40 bg-muted/10 p-3"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Diff
        </div>
        <div
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            result.passed
              ? "bg-green-500/15 text-green-700 dark:text-green-300"
              : "bg-red-500/15 text-red-700 dark:text-red-300"
          }`}
        >
          {result.passed ? "PASS" : "FAIL"}
        </div>
      </div>

      {missing.length > 0 ? (
        <DiffSection
          label="Missing"
          description="Expected but didn't happen"
          tone="missing"
        >
          {missing.map((c, i) => (
            <ToolPill
              key={`missing-${i}`}
              toolName={c.toolName}
              args={c.arguments}
              tone="missing"
            />
          ))}
        </DiffSection>
      ) : null}

      {extra.length > 0 ? (
        <DiffSection
          label="Extra"
          description="Happened but wasn't expected"
          tone="extra"
        >
          {extra.map((c, i) => (
            <ToolPill
              key={`extra-${i}`}
              toolName={c.toolName}
              args={c.arguments}
              tone="extra"
            />
          ))}
        </DiffSection>
      ) : null}

      {outOfOrder.length > 0 ? (
        <DiffSection
          label="Out of order"
          description="Happened in the wrong sequence"
          tone="order"
        >
          {outOfOrder.map((c, i) => (
            <ToolPill
              key={`order-${i}`}
              toolName={c.toolName}
              args={resolveActualArgs(actualToolCalls, c.actualIndex)}
              tone="order"
              suffix={`#${c.expectedIndex + 1} → #${c.actualIndex + 1}`}
            />
          ))}
        </DiffSection>
      ) : null}

      {argumentMismatches.length > 0 ? (
        <DiffSection
          label="Arg mismatch"
          description="Right tool, wrong args"
          tone="arg"
        >
          {argumentMismatches.map((m, i) => (
            <div
              key={`arg-${i}`}
              className="rounded border border-amber-500/30 bg-amber-500/5 p-1.5 text-xs"
            >
              <div className="font-mono font-medium">{m.toolName}</div>
              <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
                <ArgsBlock
                  label="expected"
                  args={m.expectedArgs}
                  tone="missing"
                />
                <ArgsBlock label="actual" args={m.actualArgs} tone="extra" />
              </div>
            </div>
          ))}
        </DiffSection>
      ) : null}

      {expectedToolCalls === undefined ? null : null /* prop retained for future enrichment */}
    </div>
  );
}

type Tone = "missing" | "extra" | "order" | "arg";

function DiffSection({
  label,
  description,
  tone,
  children,
}: {
  label: string;
  description: string;
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${toneClass(tone)}`}
        >
          {label}
        </span>
        <span className="text-[11px] text-muted-foreground">{description}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function ToolPill({
  toolName,
  args,
  tone,
  suffix,
}: {
  toolName: string;
  args?: Record<string, unknown>;
  tone: Tone;
  suffix?: string;
}) {
  const hasArgs = args && Object.keys(args).length > 0;
  return (
    <div
      className={`flex max-w-full items-center gap-1.5 overflow-hidden rounded border px-1.5 py-1 ${toneBorderClass(tone)}`}
    >
      <span className="truncate font-mono text-xs font-medium">{toolName}</span>
      {hasArgs ? (
        <span className="truncate text-[10px] text-muted-foreground">
          {summarizeArgs(args as Record<string, unknown>)}
        </span>
      ) : null}
      {suffix ? (
        <span className="text-[10px] text-muted-foreground">{suffix}</span>
      ) : null}
    </div>
  );
}

function ArgsBlock({
  label,
  args,
  tone,
}: {
  label: string;
  args: Record<string, unknown>;
  tone: Tone;
}) {
  return (
    <div
      className={`rounded border px-1.5 py-1 ${toneBorderClass(tone)} bg-background/50`}
    >
      <div className="mb-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
        {label}
      </div>
      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-tight">
        {safeStringify(args)}
      </pre>
    </div>
  );
}

function toneClass(tone: Tone): string {
  switch (tone) {
    case "missing":
      return "bg-red-500/15 text-red-700 dark:text-red-300";
    case "extra":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "order":
      return "bg-purple-500/15 text-purple-700 dark:text-purple-300";
    case "arg":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  }
}

function toneBorderClass(tone: Tone): string {
  switch (tone) {
    case "missing":
      return "border-red-500/30";
    case "extra":
      return "border-blue-500/30";
    case "order":
      return "border-purple-500/30";
    case "arg":
      return "border-amber-500/30";
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  if (keys.length <= 2) return keys.map((k) => `${k}=${preview(args[k])}`).join(", ");
  return `${keys.slice(0, 2).map((k) => `${k}=${preview(args[k])}`).join(", ")} +${keys.length - 2}`;
}

function preview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value.length > 24 ? `"${value.slice(0, 24)}…"` : `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? `[${value.length}]` : "{…}";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveActualArgs(
  actual: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined,
  index: number,
): Record<string, unknown> | undefined {
  if (!actual) return undefined;
  return actual[index]?.arguments;
}
