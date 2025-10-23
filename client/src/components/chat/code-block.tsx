interface CodeBlockProps {
  node: any;
  inline: boolean;
  className: string;
  children: any;
}

export function CodeBlock({
  node,
  inline,
  className,
  children,
  ...props
}: CodeBlockProps) {
  const content = String(children).trim();

  // If it's single-line (no newlines), render it inline
  // Multi-line content (with \n) renders as block
  const hasNewlines = content.includes('\n');

  if (!inline && !hasNewlines) {
    // Single-line content renders as inline code
    return (
      <code
        className={`${className} text-sm bg-zinc-100 dark:bg-zinc-800 py-1 px-2 rounded-md font-mono`}
        {...props}
      >
        {children}
      </code>
    );
  }

  if (!inline) {
    // Multi-line content renders as a block
    return (
      <div className="not-prose flex flex-col">
        <div
          {...props}
          className="text-sm w-full overflow-x-auto dark:bg-zinc-900 p-4 border border-zinc-200 dark:border-zinc-700 rounded-xl dark:text-zinc-50 text-zinc-900 font-mono whitespace-pre-wrap break-words"
        >
          {children}
        </div>
      </div>
    );
  } else {
    return (
      <code
        className={`${className} text-sm bg-zinc-100 dark:bg-zinc-800 py-1 px-2 rounded-md`}
        {...props}
      >
        {children}
      </code>
    );
  }
}
