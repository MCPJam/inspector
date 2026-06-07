import { marked } from "marked";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { Streamdown } from "streamdown";

// Resolves root-relative markdown links (`/foo/bar`) against a remote origin
// for assistant surfaces that inline markdown authored elsewhere — e.g. the
// MCPJam Agent home, which streams snippets from docs.mcpjam.com whose links
// are written relative to that site. Defaults to null so every other chat
// surface keeps rendering links exactly as the model emitted them.
const MarkdownLinkBaseContext = createContext<string | null>(null);

export function MarkdownLinkBaseProvider({
  base,
  children,
}: {
  base: string | null;
  children: ReactNode;
}) {
  return (
    <MarkdownLinkBaseContext.Provider value={base}>
      {children}
    </MarkdownLinkBaseContext.Provider>
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
    const base = useContext(MarkdownLinkBaseContext);
    const urlTransform = useMemo(() => buildUrlTransform(base), [base]);
    return (
      <Streamdown linkSafety={{ enabled: false }} urlTransform={urlTransform}>
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
