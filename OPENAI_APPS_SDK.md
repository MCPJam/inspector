# OpenAI Apps SDK Integration

MCPJam Inspector now supports **dual protocol** rendering for tool results:
1. **OpenAI Apps SDK** components (via `window.openai` API)
2. **MCP-UI** resources (via `ui://` URIs)

## How It Works

### Detection Order
When a tool returns a result, the system checks in this order:

1. **OpenAI Component**: Checks for `_meta["openai/outputTemplate"]` containing a URL
2. **MCP-UI Resource**: Checks for `ui://` resource URIs
3. **JSON Fallback**: Displays raw JSON if neither protocol is detected

### OpenAI Apps SDK Support

#### Component Detection
Tools can return results with OpenAI component metadata:

```json
{
  "content": "Tool result data",
  "_meta": {
    "openai/outputTemplate": "https://example.com/component.html"
  }
}
```

#### window.openai API
Components rendered in iframes have access to:

```javascript
window.openai = {
  // Tool input parameters
  toolInput: { param1: "value1", ... },

  // Tool output/result
  toolOutput: { result: "..." },
  
  // Layout globals (for component display)
  displayMode: 'inline',  // 'inline' | 'fullscreen' | 'pip'
  maxHeight: 600,
  theme: 'dark',          // 'dark' | 'light'
  locale: 'en-US',
  
  // Persisted widget state (restored from localStorage)
  widgetState: { ... },

  // Persist component state to localStorage
  setWidgetState: async (state) => { ... },

  // Call another MCP tool
  callTool: async (toolName, params) => { ... },

  // Send a follow-up message to the chat
  sendFollowupTurn: async (message) => { ... },
  
  // Request display mode change
  requestDisplayMode: async ({ mode }) => { ... }
}

// Note: Components access layout globals directly as properties.
// React components define their own useSyncExternalStore subscriptions
// using custom DOM events if they need reactivity.
```

#### Widget State Persistence
- Automatically saved to `localStorage` with key: `openai-widget-state:{toolCallId}`
- Restored on component load via `window.openai.widgetState`
- Updated on every `setWidgetState()` call

#### Follow-up Messages
When `sendFollowupTurn()` is called:
- Message is inserted into the chat input
- Automatically sent to the conversation
- Continues the agentic flow

## Implementation Files

### Core Components
- **`client/src/components/chat/openai-component-renderer.tsx`** - OpenAI component renderer with window.openai bridge
- **`client/src/components/chat/tool-call.tsx`** - Dual protocol detection and rendering
- **`client/src/components/chat/message.tsx`** - Message component with callback props
- **`client/src/components/ChatTab.tsx`** - Chat integration with tool execution and follow-up handlers

### Key Features
1. **Tool Execution**: Components can call other MCP tools via `window.openai.callTool()`
2. **State Persistence**: Widget state survives page refreshes via localStorage
3. **Follow-up Flow**: Components can inject messages into the conversation
4. **Sandboxed Iframes**: Components run in sandboxed iframes with script execution

## Example: OpenAI Component Response

```typescript
// MCP Tool implementation
server.registerTool(
  "get_weather",
  {
    title: "Get Weather",
    _meta: {
      "openai/outputTemplate": "https://cdn.example.com/weather-widget.html"
    },
    inputSchema: z.object({
      city: z.string()
    })
  },
  async ({ city }) => {
    return {
      temperature: 72,
      conditions: "Sunny",
      _meta: {
        "openai/outputTemplate": "https://cdn.example.com/weather-widget.html"
      }
    };
  }
);
```

```html
<!-- weather-widget.html -->
<!DOCTYPE html>
<html>
<body>
  <div id="weather"></div>
  <script>
    const { toolInput, toolOutput } = window.openai;

    document.getElementById('weather').innerHTML = `
      <h2>Weather in ${toolInput.city}</h2>
      <p>Temperature: ${toolOutput.temperature}°F</p>
      <p>Conditions: ${toolOutput.conditions}</p>
    `;

    // Save state
    window.openai.setWidgetState({ lastCity: toolInput.city });

    // Add follow-up button
    const btn = document.createElement('button');
    btn.textContent = 'Get forecast';
    btn.onclick = () => {
      window.openai.sendFollowupTurn(
        \`What's the forecast for \${toolInput.city}?\`
      );
    };
    document.body.appendChild(btn);
  </script>
</body>
</html>
```

## Migration Notes

### From MCP-UI to OpenAI Apps SDK
If you're currently using `ui://` resources, you can migrate to OpenAI Apps SDK by:

1. Host your component HTML externally
2. Add `_meta["openai/outputTemplate"]` to your tool response
3. Use `window.openai` API instead of MCP-UI events

### Backwards Compatibility
Both protocols are fully supported. Existing `ui://` resources continue to work without changes.

## Security Considerations

- Components run in sandboxed iframes (`allow-scripts allow-same-origin`)
- No direct access to parent window or DOM
- All tool calls go through controlled API endpoints
- State is scoped per tool and call ID

## Future Enhancements

Potential improvements:
- [ ] Auto-resizing iframe based on content height
- [ ] CSP (Content Security Policy) support via `_meta["openai/widgetCSP"]`
- [ ] Component lifecycle hooks
- [ ] Error boundaries for component crashes
- [ ] Component analytics/telemetry
