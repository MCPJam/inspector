interface CodeBlockProps {
  node: any;
  inline: boolean;
  className: string;
  children: any;
  fullWidth?: boolean; // Optional prop to control width behavior
}

export function CodeBlock({
  node,
  inline,
  className,
  children,
  fullWidth = false, // Default to natural sizing
  ...props
}: CodeBlockProps) {
  if (!inline) {
    return (
      <div className="not-prose flex flex-col">
        <div
          {...props}
          className={`text-sm ${fullWidth ? 'w-full' : 'w-fit max-w-full'} overflow-x-auto dark:bg-zinc-900 p-4 border border-zinc-200 dark:border-zinc-700 rounded-xl dark:text-zinc-50 text-zinc-900 font-mono whitespace-pre-wrap break-words`}
        >
          {children}
        </div>
      </div>
    );
  } else {
    return (
      <code
        className={`${className} text-sm bg-zinc-100 dark:bg-zinc-800 py-0.5 px-1 rounded-md`}
        {...props}
      >
        {children}
      </code>
    );
  }
}
