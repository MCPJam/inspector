import { CodeBlock } from './code-block';

// Test component to verify CodeBlock behavior with different content lengths
export function CodeBlockTest() {
  const shortCode = `console.log('hello');`;
  
  const mediumCode = `function calculateSum(a, b) {
  return a + b;
}`;

  const longCode = `import React, { useState, useEffect, useCallback } from 'react';
import { CodeBlock } from './code-block';

export function ComplexComponent({ data, onUpdate }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => {
    if (data) {
      processData(data);
    }
  }, [data]);
  
  const handleUpdate = useCallback((newValue) => {
    setState(newValue);
    onUpdate?.(newValue);
  }, [onUpdate]);
  
  return (
    <div className="complex-component">
      {loading ? <Spinner /> : <Content data={state} />}
    </div>
  );
}`;

  return (
    <div className="p-8 space-y-6 max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">CodeBlock Test Cases</h2>
      
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Natural Sizing (Default)</h3>
        
        <div>
          <h4 className="text-sm font-medium mb-2">Short code snippet:</h4>
          <CodeBlock node={{}} inline={false} className="" fullWidth={false}>
            {shortCode}
          </CodeBlock>
        </div>
        
        <div>
          <h4 className="text-sm font-medium mb-2">Medium code snippet:</h4>
          <CodeBlock node={{}} inline={false} className="" fullWidth={false}>
            {mediumCode}
          </CodeBlock>
        </div>
        
        <div>
          <h4 className="text-sm font-medium mb-2">Long code snippet:</h4>
          <CodeBlock node={{}} inline={false} className="" fullWidth={false}>
            {longCode}
          </CodeBlock>
        </div>
      </div>
      
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Full Width (Legacy)</h3>
        
        <div>
          <h4 className="text-sm font-medium mb-2">Short code snippet (full width):</h4>
          <CodeBlock node={{}} inline={false} className="" fullWidth={true}>
            {shortCode}
          </CodeBlock>
        </div>
        
        <div>
          <h4 className="text-sm font-medium mb-2">Long code snippet (full width):</h4>
          <CodeBlock node={{}} inline={false} className="" fullWidth={true}>
            {longCode}
          </CodeBlock>
        </div>
      </div>
      
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Inline Code</h3>
        <p>
          Here's some text with <CodeBlock node={{}} inline={true} className="">inline code</CodeBlock> in the middle.
        </p>
      </div>
      
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Multiple Blocks Side by Side</h3>
        <div className="flex gap-4">
          <CodeBlock node={{}} inline={false} className="" fullWidth={false}>
            {shortCode}
          </CodeBlock>
          <CodeBlock node={{}} inline={false} className="" fullWidth={false}>
            {mediumCode}
          </CodeBlock>
        </div>
      </div>
    </div>
  );
}
