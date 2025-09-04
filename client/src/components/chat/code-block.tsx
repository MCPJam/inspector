import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

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
  fullWidth = false,
  ...props
}: CodeBlockProps) {
  if (!inline) {
    // Extract language from className (e.g., "language-python" -> "python")
    let language = 'text';
    if (className && className.startsWith('language-')) {
      const extracted = className.replace(/^language-/, '');
      
      // Only use extracted language if it looks valid (no mixed content)
      if (extracted && 
          extracted.length < 20 && // Reasonable language name length
          /^[a-zA-Z][a-zA-Z0-9+-]*$/.test(extracted) && // Valid language name pattern
          !extracted.includes('def') && // Filter out malformed combinations
          !extracted.includes('function') &&
          !extracted.includes('class')) {
        language = extracted;
      } else {
        // If className is malformed, try to detect language from code content
        const codeContent = String(children);
        if (codeContent.includes('def ') || codeContent.includes('import ') || codeContent.includes('print(')) {
          language = 'python';
        } else if (codeContent.includes('function ') || codeContent.includes('const ') || codeContent.includes('console.log')) {
          language = 'javascript';
        } else if (codeContent.includes('public class') || codeContent.includes('System.out')) {
          language = 'java';
        } else if (codeContent.includes('#include') || codeContent.includes('printf')) {
          language = 'c';
        } else {
          language = 'text';
        }
      }
    }
    
    let codeString = String(children).replace(/\n$/, '');
    
    // Clean up common markdown parsing issues
    codeString = codeString.replace(/```$/, ''); // Remove trailing backticks
    codeString = codeString.replace(/^```\w*/, ''); // Remove leading backticks with language
    codeString = codeString.trim(); // Remove any extra whitespace
    
    // Additional cleanup for malformed content
    const lines = codeString.split('\n');
    // Remove any lines that look like markdown artifacts
    const cleanLines = lines.filter(line => !line.match(/^```\w*$/));
    codeString = cleanLines.join('\n');
    
    return (
      <div className="not-prose my-4 overflow-hidden rounded-lg bg-[#282c34] border border-gray-700">
        {/* Language tag header like Claude */}
        {language && language !== 'text' && (
          <div className="px-4 py-2 bg-gray-800 border-b border-gray-700 text-xs text-gray-300 font-medium">
            {language}
          </div>
        )}
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.875rem',
            lineHeight: '1.5',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          }}
          showLineNumbers={false}
          wrapLines={true}
          wrapLongLines={true}
          {...props}
        >
          {codeString}
        </SyntaxHighlighter>
      </div>
    );
  } else {
    // Inline code - Claude-like styling
    return (
      <code
        className="px-1.5 py-0.5 mx-0.5 text-sm bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded font-mono border border-gray-200 dark:border-gray-700"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        }}
        {...props}
      >
        {children}
      </code>
    );
  }
}
