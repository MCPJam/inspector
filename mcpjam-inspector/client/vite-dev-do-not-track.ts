import type { HtmlTagDescriptor, Plugin } from "vite";
import { telemetryOptedOut } from "../shared/sentry-identity";

/**
 * The tag that tells a dev document the server opted out, or none.
 *
 * `npm run dev:hosted` serves `index.html` from Vite, which never sees the
 * runtime config the server writes into its own document. Without this, a
 * server started with DO_NOT_TRACK would still have its dev browser
 * initialize Sentry and report errors. Only this setting is carried across:
 * the others fall back to their build-time values in dev, as before.
 */
export function devDoNotTrackTags(doNotTrack: unknown): HtmlTagDescriptor[] {
  if (!telemetryOptedOut(doNotTrack)) return [];
  return [
    {
      tag: "script",
      // Ahead of the bundle, the way the server places its runtime config.
      injectTo: "head-prepend",
      children:
        "window.__MCP_RUNTIME_CONFIG__=Object.assign({},window.__MCP_RUNTIME_CONFIG__,{doNotTrack:true});",
    },
  ];
}

/** The dev server's half of DO_NOT_TRACK; a build gets it from the server. */
export function devDoNotTrack(doNotTrack: unknown): Plugin {
  return {
    name: "mcpjam:dev-do-not-track",
    apply: "serve",
    transformIndexHtml: () => devDoNotTrackTags(doNotTrack),
  };
}
