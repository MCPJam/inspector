export interface LearnMoreEntry {
  title: string;
  videoUrl: string;
  videoThumbnail?: string;
  /** Short looping preview clip for the hover card (hosted externally, e.g. Convex storage) */
  previewVideoUrl?: string;
  description: string;
  /** Longer, high-level description for the expanded modal */
  expandedDescription?: string;
  docsUrl: string;
}

export const learnMoreContent: Record<string, LearnMoreEntry> = {
  workspaces: {
    title: "Workspaces",
    videoUrl: "https://www.youtube.com/embed/iVLr4B_HOp0",
    videoThumbnail:
      "https://outstanding-fennec-304.convex.cloud/api/storage/76ac7303-6c9a-46c9-b84e-4556c9008d73",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/f103041b-954b-49e3-83fb-bbeabdeaca03",
    description: "Organize your MCP servers into workspaces.",
    expandedDescription:
      "Each workspace saves its own set of MCP servers. Switch between workspaces with one click, connect multiple servers in each, and share any workspace with teammates so everyone works with the same configuration. Changes sync in real time, and credentials stay private — each member authenticates on their own.",
    docsUrl: "https://docs.mcpjam.com/inspector/workspaces",
  },
  servers: {
    title: "Servers",
    videoUrl: "https://www.youtube.com/embed/a5MKoPLTmXw",
    videoThumbnail:
      "https://outstanding-fennec-304.convex.cloud/api/storage/303425d5-a6cd-4225-a6fc-bea4889e3643",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/f0f85991-19aa-423e-bbd8-757b466cabae",
    description: "Connect and manage your MCP servers.",
    expandedDescription:
      "Connect to MCP servers using STDIO, SSE, or Streamable HTTP. Run multiple servers side by side, toggle them on or off, authenticate with OAuth when needed, and get a full overview of each server at a glance.",
    docsUrl: "https://docs.mcpjam.com/servers",
  },
  "app-builder": {
    title: "App Builder",
    videoUrl: "https://www.youtube.com/embed/kaCL0WdeNy0",
    videoThumbnail:
      "https://outstanding-fennec-304.convex.cloud/api/storage/a3676a4d-7262-4560-830b-60a620266f01",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/bc3fd8aa-af57-4807-9f69-d184e1e4b397",
    description: "Build and test ChatGPT apps and MCP apps locally.",
    expandedDescription:
      "A local development environment for ChatGPT apps and MCP apps. Emulate widgets, test across devices, themes, and host styles, debug CSP, and chat with your server — no ngrok or paid subscription needed.",
    docsUrl: "https://docs.mcpjam.com/app-builder",
  },
  skills: {
    title: "Skills",
    videoUrl: "https://www.youtube.com/embed/kUdPwm6GJe8",
    videoThumbnail:
      "https://outstanding-fennec-304.convex.cloud/api/storage/8b3243cc-a853-4839-b5e4-f7690d5e982c",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/673acc12-a14d-4ea7-878c-855185264e70",
    description: "View, add, and manage your skills.",
    expandedDescription:
      "View your installed skills, upload new ones, and manage them all in one place. MCPJam discovers skills from your .claude/, .mcpjam/, and .agents/ directories automatically. Use them in the App Builder or Chat — skills load based on your prompt, or inject one directly with the / command.",
    docsUrl: "https://docs.mcpjam.com/skills",
  },
  "oauth-flow": {
    title: "OAuth Debugger",
    videoUrl: "https://www.youtube.com/embed/tQSEnr4T5Qc",
    videoThumbnail:
      "https://outstanding-fennec-304.convex.cloud/api/storage/f28b5b8c-afdf-4411-9d39-199fe20fbb6b",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/13f37b5c-82c6-4d4a-b0c1-0339543b6d11",
    description: "Debug your MCP server's OAuth implementation visually.",
    expandedDescription:
      "A visual, step-by-step interface for testing your MCP server's OAuth implementation. Walk through every step of the handshake with a live sequence diagram, inspect every network request, and validate against multiple spec versions and registration methods (CIMD, DCR, or pre-registration).",
    docsUrl: "https://docs.mcpjam.com/oauth",
  },
};
