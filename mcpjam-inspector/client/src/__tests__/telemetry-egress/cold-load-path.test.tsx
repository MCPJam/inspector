// @vitest-environment-options {"url": "https://app.mcpjam.com/results/SNTLq7Zxcoldpath"}
/**
 * A cold load onto a credential PATH (`/results/<token>`, the score-results
 * route). The scenario is `support/cold-load.ts`; this file only picks the
 * URL — it has to be the page's first URL, so it is the environment's.
 */
import { sentinel } from "../../../../e2e/telemetry/egress";
import { describeColdLoad } from "./support/cold-load";

describeColdLoad({
  label: "a credential path (/results/<token>)",
  sentinel: sentinel("coldpath"),
});
