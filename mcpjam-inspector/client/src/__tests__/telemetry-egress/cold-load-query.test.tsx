// @vitest-environment-options {"url": "https://app.mcpjam.com/oauth/callback?code=SNTLq7Zxcoldcode&state=SNTLq7Zxcoldstate"}
/**
 * A cold load onto a credential QUERY (`/oauth/callback?code=&state=`, the MCP
 * OAuth callback). The scenario is `support/cold-load.ts`; this file only
 * picks the URL — it has to be the page's first URL, so it is the
 * environment's.
 */
import { sentinel } from "../../../../e2e/telemetry/egress";
import { describeColdLoad } from "./support/cold-load";

describeColdLoad({
  label: "a credential query (/oauth/callback?code=)",
  sentinel: sentinel("coldcode"),
});
