// @vitest-environment-options {"url": "https://app.mcpjam.com/#token=SNTLq7Zxcoldaccess&tab=servers"}
/**
 * A cold load onto a credential FRAGMENT (`/#token=`, the local access link).
 * The scenario is `support/cold-load.ts`; this file only picks the URL — it
 * has to be the page's first URL, so it is the environment's.
 */
import { sentinel } from "../../../../e2e/telemetry/egress";
import { describeColdLoad } from "./support/cold-load";

describeColdLoad({
  label: "a credential fragment (/#token=)",
  sentinel: sentinel("coldaccess"),
});
