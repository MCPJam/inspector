// Note: Next.js Link replaced with standard anchor tag for now
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";
import { useState } from "react";

const components: Partial<Components> = {
  code: ({ node, className, children, ...props }: any) => {
    // Check if we're inside a pre tag (this indicates a code block)
    const isInPre = node?.parent?.tagName === 'pre';
    
    // Check for language class - be more specific about valid language classes
    const hasLanguageClass = className && 
      className.startsWith('language-') && 
      className !== 'language-' &&
      !className.includes('def') && // Filter out malformed language classes
      className.length > 9; // "language-" is 9 chars, so valid languages should be longer
    
    // Check for multiline content
    const isMultiLine = typeof children === 'string' && children.includes('\n');
    
    // Code block detection: must be in pre tag OR have valid language class OR be multiline
    const isCodeBlock = isInPre || hasLanguageClass || isMultiLine;
    
    return (
      <CodeBlock 
        node={node}
        inline={!isCodeBlock}
        className={className || ''}
        children={children}
        {...props}
      />
    );
  },
  // Simplified pre handling - just pass through to children
  pre: ({ children }) => {
    return <>{children}</>;
  },
  img: ({ src, alt, ...props }) => {
    if (!src) return null;

    const [isExpanded, setIsExpanded] = useState(false);
    const [hasError, setHasError] = useState(false);

    if (hasError) {
      return (
        <div className="my-4 p-4 bg-muted/50 rounded-lg border border-border/30 text-center text-muted-foreground">
          Failed to load image: {alt || "Image"}
        </div>
      );
    }

    return (
      <div className="my-4 flex justify-center">
        <img
          src={src}
          alt={alt || "Image"}
          className={`max-w-full h-auto rounded-lg border border-border/30 shadow-sm cursor-pointer transition-all hover:shadow-md ${
            isExpanded ? "max-h-none" : "max-h-96"
          }`}
          loading="lazy"
          onClick={() => setIsExpanded(!isExpanded)}
          onError={() => setHasError(true)}
          title={isExpanded ? "Click to collapse" : "Click to expand"}
          {...props}
        />
      </div>
    );
  },
  ol: ({ children, ...props }) => {
    return (
      <ol className="list-decimal list-outside ml-4" {...props}>
        {children}
      </ol>
    );
  },
  li: ({ children, ...props }) => {
    return (
      <li className="py-1" {...props}>
        {children}
      </li>
    );
  },
  ul: ({ children, ...props }) => {
    return (
      <ul className="list-decimal list-outside ml-4" {...props}>
        {children}
      </ul>
    );
  },
  strong: ({ children, ...props }) => {
    return (
      <span className="font-semibold" {...props}>
        {children}
      </span>
    );
  },
  a: ({ children, ...props }) => {
    return (
      <a
        className="text-blue-500 hover:underline"
        target="_blank"
        rel="noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },
  h1: ({ children, ...props }) => {
    return (
      <h1 className="text-3xl font-semibold mt-6 mb-2" {...props}>
        {children}
      </h1>
    );
  },
  h2: ({ children, ...props }) => {
    return (
      <h2 className="text-2xl font-semibold mt-6 mb-2" {...props}>
        {children}
      </h2>
    );
  },
  h3: ({ children, ...props }) => {
    return (
      <h3 className="text-xl font-semibold mt-6 mb-2" {...props}>
        {children}
      </h3>
    );
  },
  h4: ({ children, ...props }) => {
    return (
      <h4 className="text-lg font-semibold mt-6 mb-2" {...props}>
        {children}
      </h4>
    );
  },
  h5: ({ children, ...props }) => {
    return (
      <h5 className="text-base font-semibold mt-6 mb-2" {...props}>
        {children}
      </h5>
    );
  },
  h6: ({ children, ...props }) => {
    return (
      <h6 className="text-sm font-semibold mt-6 mb-2" {...props}>
        {children}
      </h6>
    );
  },
};

const remarkPlugins = [remarkGfm];

const NonMemoizedMarkdown = ({ children }: { children: string }) => {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {children}
    </ReactMarkdown>
  );
};

// Note: We can't memoize this component because it contains stateful img components
// The memoization would prevent the state from working properly
export const Markdown = NonMemoizedMarkdown;
