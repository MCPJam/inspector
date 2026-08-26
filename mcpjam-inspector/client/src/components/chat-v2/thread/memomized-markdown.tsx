import { marked } from "marked";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Streamdown, defaultUrlTransform, type UrlTransform } from "streamdown";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";

// Per-surface markdown rendering knobs for surfaces that inline content
// authored elsewhere — e.g. the MCPJam Agent home, which streams docs from
// docs.mcpjam.com. The defaults (`linkBase: null`, `trustLinks: false`) keep
// every other chat surface rendering links exactly as the model emitted them
// and preserve Streamdown's built-in link-safety confirmation.
type MarkdownSurfaceConfig = {
  // When set, root-relative hrefs (`/foo`) are rewritten to `${linkBase}/foo`
  // via Streamdown's `urlTransform`.
  linkBase: string | null;
  // When true, Streamdown's `linkSafety` confirmation modal is disabled for
  // this surface — use only when the surface inlines content from a trusted
  // origin and Streamdown's modal styling would otherwise render unusably
  // (the project does not import `streamdown/styles.css`).
  trustLinks: boolean;
};

const DEFAULT_SURFACE_CONFIG: MarkdownSurfaceConfig = {
  linkBase: null,
  trustLinks: false,
};

const MarkdownSurfaceContext =
  createContext<MarkdownSurfaceConfig>(DEFAULT_SURFACE_CONFIG);

export function MarkdownLinkBaseProvider({
  base,
  trustLinks = false,
  children,
}: {
  base: string | null;
  trustLinks?: boolean;
  children: ReactNode;
}) {
  const value = useMemo<MarkdownSurfaceConfig>(
    () => ({ linkBase: base, trustLinks }),
    [base, trustLinks],
  );
  return (
    <MarkdownSurfaceContext.Provider value={value}>
      {children}
    </MarkdownSurfaceContext.Provider>
  );
}

function buildUrlTransform(base: string | null): UrlTransform | undefined {
  if (!base) return undefined;
  const trimmed = base.replace(/\/$/, "");
  // Only the root-relative rewrite is custom; every other href falls through
  // to Streamdown's defaultUrlTransform so dangerous protocols
  // (`javascript:`, `vbscript:`, non-image `data:`, …) are still stripped.
  // Without this delegation a model-emitted `[x](javascript:alert(1))` on a
  // `trustLinks` surface would render as a clickable anchor.
  return (url, key, node) => {
    if (url.startsWith("/") && !url.startsWith("//")) {
      return trimmed + url;
    }
    return defaultUrlTransform(url, key, node);
  };
}

// INSPECTOR-CLIENT-253. Both marked (below) and Streamdown's remark pipeline
// recurse once per level of block nesting, so `- x\n  ` + 2000 `>` — about 2KB,
// and reachable verbatim from any MCP tool result — exhausts the JS stack.
// Well under the ~1500-level cliff measured against marked 16.4.2.
const MAX_MARKDOWN_NESTING = 200;
// Backstop for inputs that are merely enormous rather than deep.
const MAX_MARKDOWN_CHARS = 512_000;

// Cheap O(n) proxy over the three nesting axes: `>` markers (one level each),
// indentation (two columns per level, marked's tightest list nesting), and
// `*`/`_` runs (two delimiters per emphasis level). Over-counting a deeply
// indented code block only costs a plain-text render.
function blockNestingDepth(markdown: string): number {
  let max = 0;
  let i = 0;
  while (i < markdown.length) {
    let columns = 0;
    let markers = 0;
    while (i < markdown.length) {
      const char = markdown[i];
      if (char === " ") columns += 1;
      else if (char === "\t") columns += 4;
      else if (char === ">") markers += 1;
      else break;
      i += 1;
    }
    // Longest `*`/`_` run on the line. marked's inline lexer recurses once per
    // emphasis pair, so `"*".repeat(5000) + "x" + "*".repeat(5000)` overflows
    // the stack — and the leading-whitespace scan above scores it 0.
    let run = 0;
    let longestRun = 0;
    let previous = "";
    while (i < markdown.length && markdown[i] !== "\n") {
      const char = markdown[i];
      if (char === "*" || char === "_") {
        run = char === previous ? run + 1 : 1;
        previous = char;
        if (run > longestRun) longestRun = run;
      } else {
        run = 0;
        previous = "";
      }
      i += 1;
    }
    i += 1;

    const depth = markers + (columns >> 1) + (longestRun >> 1);
    if (depth > max) max = depth;
  }
  return max;
}

// `null` means "too deep or too big to parse safely — render it as plain text".
function parseMarkdownIntoBlocks(markdown: string): string[] | null {
  if (markdown.length > MAX_MARKDOWN_CHARS) return null;
  if (blockNestingDepth(markdown) > MAX_MARKDOWN_NESTING) return null;
  try {
    const tokens = marked.lexer(markdown);
    if (tokens.length === 0) {
      return [markdown];
    }
    return tokens.map((token) => token.raw);
  } catch {
    // Belt and braces for anything the depth scan under-counts.
    return null;
  }
}

function PlainTextMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <pre
      className={cn("whitespace-pre-wrap break-words font-sans", className)}
      data-testid="markdown-plain-text"
    >
      {content}
    </pre>
  );
}

const MemoizedMarkdownBlock = memo(
  ({ content }: { content: string }) => {
    const { linkBase, trustLinks } = useContext(MarkdownSurfaceContext);
    const urlTransform = useMemo(
      () => buildUrlTransform(linkBase),
      [linkBase],
    );
    const linkSafety = useMemo(
      () => (trustLinks ? { enabled: false } : undefined),
      [trustLinks],
    );
    return (
      <Streamdown linkSafety={linkSafety} urlTransform={urlTransform}>
        {content}
      </Streamdown>
    );
  },
  (prevProps, nextProps) => {
    if (prevProps.content !== nextProps.content) return false;
    return true;
  },
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

function MarkdownBlocks({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  // One-way fuse per message, mirroring the boundary above. `useMemo` is keyed
  // on the whole streaming content, so without it a payload that only the
  // `try/catch` catches re-enters marked.lexer on every tick.
  const failed = useRef(false);
  const blocks = useMemo(
    () => (failed.current ? null : parseMarkdownIntoBlocks(content)),
    [content],
  );

  if (blocks === null) {
    failed.current = true;
    return <PlainTextMarkdown content={content} className={className} />;
  }

  return blocks.map((block, index) => (
    <div className={className} key={`markdown-block_${index}`}>
      <MemoizedMarkdownBlock content={block} />
    </div>
  ));
}

export const MemoizedMarkdown = memo(
  ({ content, className }: { content: string; className?: string }) => (
    // The fuse: a throw here used to unmount the whole route through the
    // router's errorElement, taking the conversation with it. Once tripped it
    // stays on plain text for this message, which still shows every character.
    <ErrorBoundary
      name="markdown-render"
      fallback={<PlainTextMarkdown content={content} className={className} />}
    >
      <MarkdownBlocks content={content} className={className} />
    </ErrorBoundary>
  ),
  (prevProps, nextProps) => {
    if (prevProps.content !== nextProps.content) return false;
    if (prevProps.className !== nextProps.className) return false;
    return true;
  },
);

MemoizedMarkdown.displayName = "MemoizedMarkdown";
