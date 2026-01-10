import { marked } from "marked";
import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  if (tokens.length === 0) {
    return [markdown];
  }
  return tokens.map((token) => token.raw);
}

const MemoizedMarkdownBlock = memo(
  ({ content }: { content: string }) => {
    return <Streamdown>{content}</Streamdown>;
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
