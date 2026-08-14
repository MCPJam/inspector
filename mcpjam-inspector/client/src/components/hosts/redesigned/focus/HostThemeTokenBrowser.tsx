import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  TOKEN_CATEGORY_LABELS,
  demoPriorCaptures,
  diffChangeCount,
  diffStyleVariables,
  exportStyleVariablesCss,
  exportStyleVariablesJson,
  extractStyleVariables,
  groupStyleVariables,
  hostStyleDisplayName,
  isColorToken,
  parseTokenValue,
  type StyleVariableDiff,
} from "@/lib/host-theme-tokens";
import { FocusBlock, SegmentedControl } from "./primitives";

interface HostThemeTokenBrowserProps {
  hostContext: Record<string, unknown>;
  hostStyle?: string;
}

type CopyKind = "css" | "json" | string;
type BrowserView = "tokens" | "diff";

export function HostThemeTokenBrowser({
  hostContext,
  hostStyle,
}: HostThemeTokenBrowserProps) {
  const variables = useMemo(
    () => extractStyleVariables(hostContext),
    [hostContext],
  );
  const priors = useMemo(
    () => (variables ? demoPriorCaptures(hostStyle, variables) : []),
    [hostStyle, variables],
  );
  const [copied, setCopied] = useState<CopyKind | null>(null);
  const [view, setView] = useState<BrowserView>("tokens");
  const [watching, setWatching] = useState(false);

  const copy = async (kind: CopyKind, text: string) => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(kind);
    window.setTimeout(() => {
      setCopied((current) => (current === kind ? null : current));
    }, 1400);
  };

  if (!variables) {
    return (
      <FocusBlock
        title="Host theme"
        subtitle="Tokens this host sends to MCP Apps."
      >
        <p
          data-testid="host-theme-empty"
          className="text-[12px] text-muted-foreground"
        >
          No theme tokens on this host. Add{" "}
          <code className="font-mono text-[11px]">styles.variables</code> in
          the JSON below.
        </p>
      </FocusBlock>
    );
  }

  const count = Object.keys(variables).length;
  const hostName = hostStyleDisplayName(hostStyle);
  const lastCapture = priors[0];
  const diff = lastCapture
    ? diffStyleVariables(lastCapture.variables, variables)
    : null;
  const groups = groupStyleVariables(variables);
  const cliHost = hostStyle === "chatgpt" ? "chatgpt" : "claude";
  const watchHint = watching
    ? `Watching ${hostName}. mcpjam hosts diff ${cliHost} fails CI on the next change.`
    : `npm package or mcpjam hosts diff ${cliHost} — fail CI when this host restyles, not after ship.`;

  return (
    <FocusBlock
      title="Host theme"
      subtitle={`${count} tokens this host sends to MCP Apps.`}
      action={
        <div className="flex items-center gap-2">
          {lastCapture ? (
            <div className="flex items-center gap-1.5 pr-1">
              <label
                htmlFor="host-theme-watch"
                className="text-[11.5px] text-muted-foreground"
              >
                Watch
              </label>
              <Switch
                id="host-theme-watch"
                checked={watching}
                onCheckedChange={setWatching}
                aria-label="Watch host theme"
              />
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11.5px]"
            onClick={() =>
              void copy("css", exportStyleVariablesCss(variables))
            }
          >
            {copied === "css" ? "Copied CSS" : "Copy CSS"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11.5px]"
            onClick={() =>
              void copy("json", exportStyleVariablesJson(variables))
            }
          >
            {copied === "json" ? "Copied JSON" : "Copy JSON"}
          </Button>
        </div>
      }
    >
      <div
        data-testid="host-theme-token-browser"
        className="flex flex-col gap-3"
      >
        {lastCapture ? (
          <div className="flex flex-col gap-1.5">
            <SegmentedControl
              ariaLabel="Theme view"
              value={view}
              onChange={setView}
              options={[
                { value: "tokens", label: "Tokens" },
                { value: "diff", label: "Diff" },
              ]}
            />
            <p
              data-testid="host-theme-watch-note"
              className="text-[11px] leading-snug text-muted-foreground"
            >
              {watchHint}
            </p>
          </div>
        ) : (
          <p
            data-testid="host-theme-no-history"
            className="text-[11.5px] text-muted-foreground"
          >
            No prior captures yet.
          </p>
        )}

        {view === "diff" && diff && lastCapture ? (
          <DiffTokenList
            diff={diff}
            sinceLabel={formatCaptureDay(lastCapture.capturedAt)}
            copied={copied}
            onCopyName={(name) => void copy(name, name)}
          />
        ) : (
          <TokenGroups
            groups={groups}
            copied={copied}
            onCopyName={(name) => void copy(name, name)}
          />
        )}
      </div>
    </FocusBlock>
  );
}

function formatCaptureDay(capturedAt: number): string {
  return new Date(capturedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function TokenGroups({
  groups,
  copied,
  onCopyName,
}: {
  groups: ReturnType<typeof groupStyleVariables>;
  copied: CopyKind | null;
  onCopyName: (name: string) => void;
}) {
  return (
    <>
      {groups.map(({ category, tokens }) => (
        <section key={category} className="flex flex-col gap-1">
          <h4 className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {TOKEN_CATEGORY_LABELS[category]}
          </h4>
          <ul className="divide-y divide-border/50 rounded-md border border-border/70">
            {tokens.map((token) => (
              <TokenRow
                key={token.name}
                name={token.name}
                value={token.value}
                copied={copied === token.name}
                onCopy={() => onCopyName(token.name)}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function DiffTokenList({
  diff,
  sinceLabel,
  copied,
  onCopyName,
}: {
  diff: StyleVariableDiff;
  sinceLabel: string;
  copied: CopyKind | null;
  onCopyName: (name: string) => void;
}) {
  const changeCount = diffChangeCount(diff);

  return (
    <div data-testid="host-theme-diff" className="flex flex-col gap-2.5">
      <p
        data-testid="host-theme-changelog"
        className="text-[12px] text-muted-foreground"
      >
        {changeCount} {changeCount === 1 ? "token" : "tokens"} changed since{" "}
        {sinceLabel}.
      </p>
      {diff.changed.length > 0 ? (
        <DiffSection title="changed">
          {diff.changed.map((token) => (
            <li key={token.name}>
              <button
                type="button"
                onClick={() => onCopyName(token.name)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left",
                  "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                title="Copy token name"
              >
                <BeforeAfterSwatch from={token.from} to={token.to} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                  {copied === token.name ? "Copied" : token.name}
                </span>
                <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
                  was {shortValue(token.from)}
                </span>
              </button>
            </li>
          ))}
        </DiffSection>
      ) : null}
      {diff.added.length > 0 ? (
        <DiffSection title="added">
          {diff.added.map((token) => (
            <TokenRow
              key={token.name}
              name={token.name}
              value={token.value}
              copied={copied === token.name}
              onCopy={() => onCopyName(token.name)}
              mark="+"
            />
          ))}
        </DiffSection>
      ) : null}
      {diff.removed.length > 0 ? (
        <DiffSection title="removed">
          {diff.removed.map((token) => (
            <TokenRow
              key={token.name}
              name={token.name}
              value={token.value}
              copied={copied === token.name}
              onCopy={() => onCopyName(token.name)}
              mark="−"
              muted
            />
          ))}
        </DiffSection>
      ) : null}
    </div>
  );
}

function DiffSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h4>
      <ul className="divide-y divide-border/50 rounded-md border border-border/70">
        {children}
      </ul>
    </section>
  );
}

function TokenRow({
  name,
  value,
  copied,
  onCopy,
  mark,
  muted,
}: {
  name: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  mark?: string;
  muted?: boolean;
}) {
  const parsed = parseTokenValue(value);
  const showChip = isColorToken(name, value);
  return (
    <li>
      <button
        type="button"
        onClick={onCopy}
        className={cn(
          "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left",
          "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          muted && "opacity-55",
        )}
        title="Copy token name"
      >
        {showChip ? (
          <SplitSwatch
            light={
              parsed.kind === "light-dark" ? parsed.light : parsed.value
            }
            dark={parsed.kind === "light-dark" ? parsed.dark : parsed.value}
            split={parsed.kind === "light-dark"}
          />
        ) : (
          <TypeMark name={name} value={value} />
        )}
        {mark ? (
          <span className="w-3 font-mono text-[11px] text-muted-foreground">
            {mark}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
          {copied ? "Copied" : name}
        </span>
        <span className="hidden max-w-[42%] truncate font-mono text-[10.5px] text-muted-foreground sm:block">
          {value}
        </span>
      </button>
    </li>
  );
}

function BeforeAfterSwatch({ from, to }: { from: string; to: string }) {
  const fromParsed = parseTokenValue(from);
  const toParsed = parseTokenValue(to);
  const fromColor =
    fromParsed.kind === "light-dark" ? fromParsed.light : fromParsed.value;
  const toColor =
    toParsed.kind === "light-dark" ? toParsed.light : toParsed.value;
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      <MiniSwatch color={fromColor} />
      <span className="text-[9px] text-muted-foreground">→</span>
      <MiniSwatch color={toColor} />
    </span>
  );
}

function MiniSwatch({ color }: { color: string }) {
  return (
    <span
      className="h-[22px] w-[18px] overflow-hidden rounded-[4px] border border-black/10 dark:border-white/15"
      style={{
        backgroundImage:
          "repeating-conic-gradient(#d4d4d4 0% 25%, #f5f5f5 0% 50%)",
        backgroundSize: "8px 8px",
      }}
    >
      <span className="block h-full w-full" style={{ background: color }} />
    </span>
  );
}

function shortValue(value: string): string {
  return value.length > 28 ? `${value.slice(0, 26)}…` : value;
}

function SplitSwatch({
  light,
  dark,
  split,
}: {
  light: string;
  dark: string;
  split: boolean;
}) {
  return (
    <span
      aria-hidden
      className="relative isolate h-[22px] w-[36px] shrink-0 overflow-hidden rounded-[5px] border border-black/10 dark:border-white/15"
      style={{
        backgroundImage:
          "repeating-conic-gradient(#d4d4d4 0% 25%, #f5f5f5 0% 50%)",
        backgroundSize: "8px 8px",
      }}
    >
      {split ? (
        <>
          <span
            className="absolute inset-y-0 left-0 w-1/2"
            style={{ background: light }}
          />
          <span
            className="absolute inset-y-0 right-0 w-1/2"
            style={{ background: dark }}
          />
          <span className="absolute inset-y-0 left-1/2 w-px bg-black/20 dark:bg-white/25" />
        </>
      ) : (
        <span className="absolute inset-0" style={{ background: light }} />
      )}
    </span>
  );
}

function TypeMark({ name, value }: { name: string; value: string }) {
  if (name.startsWith("--font-") && name.endsWith("-size")) {
    return (
      <span
        aria-hidden
        className="flex h-[22px] w-[36px] shrink-0 items-end justify-center rounded-[5px] border border-border/70 bg-muted/30 font-serif text-[13px] leading-none text-foreground/80"
      >
        Aa
      </span>
    );
  }
  if (name.startsWith("--border-radius-")) {
    return (
      <span
        aria-hidden
        className="h-[22px] w-[36px] shrink-0 border border-border bg-muted/20"
        style={{ borderRadius: value }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-[22px] w-[36px] shrink-0 items-center justify-center rounded-[5px] border border-dashed border-border/80 font-mono text-[9px] text-muted-foreground"
    >
      ·
    </span>
  );
}
