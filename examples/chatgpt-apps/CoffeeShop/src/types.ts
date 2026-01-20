export interface CoffeeToolOutput {
  coffeeCount: number;
  message: string;
}

export interface CallToolResult {
  structuredContent?: CoffeeToolOutput;
}

export interface SetGlobalsEventDetail {
  globals: {
    toolOutput?: CoffeeToolOutput;
  };
}

export interface OpenAI {
  toolOutput?: CoffeeToolOutput;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  openExternal: (options: { href: string }) => void;
  requestDisplayMode?: (options: { mode: "inline" | "pip" | "fullscreen" }) => void;
}

declare global {
  interface Window {
    openai?: OpenAI;
  }

  interface WindowEventMap {
    "openai:set_globals": CustomEvent<SetGlobalsEventDetail>;
  }
}
