import { Markdown } from './markdown';

export function MarkdownTest() {
  const testMarkdown = `
Here's some text with inline code like \`num1\` and \`num2\` in the middle.

And here's a code block:

\`\`\`python
def calculate(a, b):
    return a + b
\`\`\`

More text with \`inline code\` here.
`;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">Markdown Test</h2>
      <div className="prose prose-slate max-w-none">
        <Markdown>{testMarkdown}</Markdown>
      </div>
    </div>
  );
}
