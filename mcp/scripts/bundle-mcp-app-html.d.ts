declare module "./scripts/bundle-mcp-app-html.mjs" {
  import type { Plugin } from "vite";

  export function bundleMcpAppsHtml(): void;
  export function bundleMcpAppsHtmlPlugin(): Plugin;
}
