/**
 * Style-token browser for the Apps tab.
 *
 * Shows the exact `hostContext.styles` payload this host hands an MCP App
 * view on `ui/initialize` — the `variables` map plus the `css.fonts`
 * string — so you can read the tokens a widget will actually see without
 * mounting a widget and cracking open DevTools.
 *
 * SOURCE — and a known gap. Values come from `resolveEffectiveHostStyle`:
 * the registry preset named by `hostStyle`, with the config's persisted
 * `chatUiOverride` layered on top. That is NOT what the widget host resolves.
 * `widget-react/src/mcp-apps-renderer.tsx` reads the preset via
 * `getHostStyleOrDefault`, ignores `chatUiOverride`, merges the config's
 * `hostContext.styles.variables` over it and drops non-SEP keys through
 * `sanitizeHostStyleVariables`. So a host carrying either an override or a
 * `hostContext` palette is displayed differently from what its views receive.
 * Rebuilding this on `readStyleVariable` (`lib/host-config-field-schema.ts`),
 * which the compare matrix already uses, is the fix; until then the subtitle
 * below deliberately does not claim to be the wire payload.
 *
 * READ-ONLY on purpose. Editing lives in the `chatUiOverride` surfaces;
 * this block is the "what does the widget get" view.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { resolveEffectiveHostStyle } from "@/lib/client-styles";
import { cn } from "@/lib/utils";
import { STYLE_SWATCH_CHECKERBOARD } from "@/components/hosts/style-token-swatch";

/**
 * Presentation buckets, in the order SEP-1865 lists its style variables
 * (`McpUiStyleVariableKey`): the four color families, then type, then the
 * shape/shadow primitives. `other` is a catch-all so a host that sends a
 * non-spec token still renders instead of vanishing from the list.
 */
type StyleTokenGroupId =
  | "background"
  | "text"
  | "border"
  | "ring"
  | "type"
  | "shape"
  | "shadow"
  | "other";

const STYLE_TOKEN_GROUPS: ReadonlyArray<{
  id: StyleTokenGroupId;
  label: string;
}> = [
  { id: "background", label: "Background" },
  { id: "text", label: "Text" },
  { id: "border", label: "Border" },
  { id: "ring", label: "Ring" },
  { id: "type", label: "Type" },
  { id: "shape", label: "Shape" },
  { id: "shadow", label: "Shadow" },
  { id: "other", label: "Other" },
];

function groupForToken(name: string): StyleTokenGroupId {
  if (name.startsWith("--color-background")) return "background";
  if (name.startsWith("--color-text")) return "text";
  if (name.startsWith("--color-border")) return "border";
  if (name.startsWith("--color-ring")) return "ring";
  if (name.startsWith("--font")) return "type";
  if (name.startsWith("--border-radius") || name.startsWith("--border-width"))
    return "shape";
  if (name.startsWith("--shadow")) return "shadow";
  return "other";
}

interface StyleTokenRow {
  name: string;
  light: string | undefined;
  dark: string | undefined;
}

/**
 * One label for a token's light and dark values. Identical values collapse
 * to the bare value; a real pair renders as CSS `light-dark(…)`, which is
 * both the shortest honest rendering and paste-able into a stylesheet.
 */
function formatTokenValue(row: StyleTokenRow): string {
  const { name, light, dark } = row;
  if (light !== undefined && dark !== undefined) {
    if (light === dark) return light;
    // CSS `light-dark()` only accepts colors, so synthesizing it for a size,
    // radius or font stack would print an invalid declaration in a block
    // whose values are meant to be paste-able. Those show both values plainly.
    return name.startsWith("--color-")
      ? `light-dark(${light}, ${dark})`
      : `${light} / ${dark}`;
  }
  return light ?? dark ?? "—";
}

/**
 * Per-token preview chip. Colors render as a split light/dark swatch;
 * radius, shadow and type tokens preview the property they drive so the
 * row reads at a glance. Values land on real CSS properties (never spliced
 * into a CSS string), so a malformed token from a BYO host is dropped by
 * the CSSOM instead of leaking into a neighboring declaration.
 */
function StyleTokenPreview({ row }: { row: StyleTokenRow }) {
  const { name, light, dark } = row;
  const boxClasses =
    "flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-border/70";
  // Non-color previews are single-valued, so they take whichever theme
  // defines the token. A host may send a token in one theme only — reading
  // `light` alone would render a dark-only token with no preview at all.
  const previewValue = light ?? dark;

  if (name.startsWith("--color-")) {
    return (
      <span className={boxClasses} style={STYLE_SWATCH_CHECKERBOARD}>
        <span className="h-full w-1/2" style={{ backgroundColor: light }} />
        <span className="h-full w-1/2" style={{ backgroundColor: dark }} />
      </span>
    );
  }

  if (name.startsWith("--shadow")) {
    return (
      <span className={cn(boxClasses, "bg-background")}>
        <span
          className="size-3 rounded-[2px] bg-background"
          style={{ boxShadow: previewValue }}
        />
      </span>
    );
  }

  if (name.startsWith("--border-radius") || name.startsWith("--border-width")) {
    return (
      <span className={cn(boxClasses, "bg-muted/40")}>
        <span
          className="size-3.5 border border-foreground/40"
          style={
            name.startsWith("--border-radius")
              ? { borderRadius: previewValue }
              : { borderWidth: previewValue }
          }
        />
      </span>
    );
  }

  // Type tokens: the glyph renders in the property the token drives, so a
  // mono family reads as mono and a bold weight reads as bold. Line-height
  // has nothing to show on a single glyph and gets a neutral mark.
  const isSizeToken = name.endsWith("-size");
  const isFamilyToken = name === "--font-sans" || name === "--font-mono";
  const isWeightToken = name.startsWith("--font-weight");
  const glyphStyle: CSSProperties = {};
  if (isSizeToken && previewValue !== undefined) {
    // Heading sizes run to 48px, well past the 20px chip. The raw value
    // goes onto a custom property and the ceiling lives in a STATIC
    // declaration, so the untrusted value still reaches CSS through the
    // CSSOM (never spliced into a string) and a garbage token simply
    // fails to resolve.
    (glyphStyle as Record<string, string>)["--style-token-preview-size"] =
      previewValue;
    glyphStyle.fontSize = "min(var(--style-token-preview-size), 12px)";
  }
  if (isFamilyToken) glyphStyle.fontFamily = previewValue;
  if (isWeightToken) glyphStyle.fontWeight = previewValue;
  return (
    <span
      className={cn(
        boxClasses,
        "bg-muted/40 text-[9px] leading-none text-muted-foreground"
      )}
      style={glyphStyle}
    >
      {isSizeToken || isFamilyToken || isWeightToken ? "Aa" : "·"}
    </span>
  );
}

export function HostStyleTokens({ draft }: { draft: HostConfigInputV2 }) {
  const [open, setOpen] = useState(false);

  const { rows, fontCss } = useMemo(() => {
    const definition = resolveEffectiveHostStyle({
      hostStyle: draft.hostStyle,
      chatUiOverride: draft.chatUiOverride,
    });
    // `McpUiStyles` is `Record<key, string | undefined>`; widen to a plain
    // record so tokens outside the spec union (BYO hosts) still enumerate.
    // `?? {}`: the resolver hands back `styleVariables[theme]` unguarded and
    // `chatUiOverride` is never validated at runtime, so a config persisting
    // only one theme would otherwise throw out of `Object.keys` and take the
    // whole Apps tab down with it.
    const light = (definition.mcp.resolveStyleVariables("light") ??
      {}) as Record<string, string | undefined>;
    const dark = (definition.mcp.resolveStyleVariables("dark") ?? {}) as Record<
      string,
      string | undefined
    >;
    const names = [
      ...new Set([...Object.keys(light), ...Object.keys(dark)]),
    ].sort();
    const collected: StyleTokenRow[] = [];
    for (const name of names) {
      // A key present but undefined in both themes is not sent over the
      // wire — don't list it as if the host advertised it.
      if (light[name] === undefined && dark[name] === undefined) continue;
      collected.push({ name, light: light[name], dark: dark[name] });
    }
    return { rows: collected, fontCss: definition.mcp.fontCss };
  }, [draft.hostStyle, draft.chatUiOverride]);

  const grouped = useMemo(
    () =>
      STYLE_TOKEN_GROUPS.map((group) => ({
        ...group,
        rows: rows.filter((row) => groupForToken(row.name) === group.id),
      })).filter((group) => group.rows.length > 0),
    [rows]
  );

  // Which row just copied, so its icon can confirm in place. One name rather
  // than a set: a second copy supersedes the first, and two rows holding a
  // check at once would suggest both are on the clipboard.
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  // Copying `var(--token)` rather than the bare name or the value: that is
  // the form a widget author pastes into their own stylesheet, and it keeps
  // the widget themed by the host instead of pinned to today's hex.
  const copyToken = async (name: string) => {
    // The shared helper, not `navigator.clipboard` directly: it falls back to
    // execCommand where the async API is unavailable (non-secure-origin dev
    // servers, older Electron webviews), which is why every other copy
    // affordance in the app keeps working there.
    if (await copyToClipboard(`var(${name})`)) {
      // The row's own check mark is the confirmation — a toast for a gesture
      // this small, repeated down a list of 76, is noise.
      setCopiedToken(name);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedToken(null), 1500);
      return;
    }
    toast.error("Couldn't copy to clipboard");
  };

  return (
    <div className="rounded-[10px] border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="apps-extension-style-tokens"
        className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-muted/40"
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium">Style tokens</span>
          <span className="text-[11px] text-muted-foreground">
            Style variables resolved for this host config.
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {rows.length}
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </div>
      </button>

      {open ? (
        <div
          id="apps-extension-style-tokens"
          className="flex flex-col border-t border-border"
        >
          {rows.length === 0 ? (
            <p className="px-3.5 py-3 text-[11.5px] text-muted-foreground">
              This host sends no style variables — views fall back to their own
              defaults.
            </p>
          ) : (
            grouped.map((group) => (
              <div key={group.id} className="flex flex-col">
                <div className="bg-muted/40 px-3.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                {group.rows.map((row) => (
                  // The whole row is the button, with the icon as its
                  // affordance: a real <button> nested inside another is
                  // invalid markup, and splitting them would shrink a
                  // full-width target to 12px and add a second tab stop to
                  // every one of 76 rows. The icon holds its space while
                  // hidden so the row doesn't shift on hover.
                  <button
                    key={row.name}
                    type="button"
                    onClick={() => void copyToken(row.name)}
                    aria-label={`Copy var(${row.name})`}
                    title={`Copy var(${row.name})`}
                    className="group flex items-center gap-2.5 border-b border-border/50 px-3.5 py-1.5 text-left last:border-b-0 hover:bg-muted/40"
                  >
                    <StyleTokenPreview row={row} />
                    <code className="font-mono text-[11.5px]">{row.name}</code>
                    {/* The row's own title/aria-label describe the copy, so
                        the truncated value needs a title of its own or it is
                        unreachable once clipped — and the value is the point
                        of the block. */}
                    <code
                      title={formatTokenValue(row)}
                      className="ml-auto truncate font-mono text-[11px] text-muted-foreground"
                    >
                      {formatTokenValue(row)}
                    </code>
                    {copiedToken === row.name ? (
                      <Check className="h-3 w-3 shrink-0 text-foreground" />
                    ) : (
                      <Copy
                        aria-hidden
                        className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      />
                    )}
                  </button>
                ))}
              </div>
            ))
          )}

          {/* `styles.css.fonts` travels in the same payload as the
              variables — a widget that renders in the host's typeface
              needs both, so show both. */}
          <div className="flex flex-col">
            <div className="bg-muted/40 px-3.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Fonts
            </div>
            {fontCss.trim() ? (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
                {fontCss.trim()}
              </pre>
            ) : (
              <p className="px-3.5 py-2 text-[11.5px] text-muted-foreground">
                No font CSS — views inherit the sandbox iframe's defaults.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
