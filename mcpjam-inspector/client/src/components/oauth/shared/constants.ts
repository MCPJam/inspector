// Actor configuration
export const ACTORS = {
  client: { label: "Client", color: "#10b981" }, // Green
  browser: { label: "User-Agent (Browser)", color: "#8b5cf6" }, // Purple
  mcpServer: { label: "MCP Server (Resource Server)", color: "#f59e0b" }, // Orange
  authServer: { label: "Authorization Server", color: "#3b82f6" }, // Blue
};

// Layout constants
export const ACTOR_X_POSITIONS = {
  browser: 100,
  client: 350,
  mcpServer: 650,
  authServer: 950,
};

export const ACTION_SPACING = 180; // Vertical space between actions
export const START_Y = 120; // Initial Y position for first action
export const SEGMENT_HEIGHT = 80; // Height of each segment
