import { marked } from "marked";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { Streamdown } from "streamdown";

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

function buildUrlTransform(base: string | null) {
  if (!base) return undefined;
  const trimmed = base.replace(/\/$/, "");
  return (url: string) => {
    if (url.startsWith("/") && !url.startsWith("//")) {
      return trimmed + url;
    }
    return url;
  };
}

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  if (tokens.length === 0) {
    return [markdown];
  }
  return tokens.map((token) => token.raw);
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

export const MemoizedMarkdown = memo(
  ({ content, className }: { content: string; className?: string }) => {
    const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content]);

    return blocks.map((block, index) => (
      <div className={className} key={`markdown-block_${index}`}>
        <MemoizedMarkdownBlock content={block} />
      </div>
    ));
  },
  (prevProps, nextProps) => {
    if (prevProps.content !== nextProps.content) return false;
    if (prevProps.className !== nextProps.className) return false;
    return true;
  },
);

MemoizedMarkdown.displayName = "MemoizedMarkdown";
