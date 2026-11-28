/**
 * The web client runtime's place in the server: the account routes, and the
 * environment each turn builds its account, connectors and browser from.
 * Both server entries (`index.ts`, `app.ts`) call this one function.
 *
 * Hosted, the environment is the backend's accounts and the hosted browser,
 * and recovery pauses a signed-out run on the backend's reconnect request.
 * A local Inspector gets one only with `web-clients-enabled` on in its flag
 * file: its connectors answer to no backend, so the flag file is the switch
 * (see `docs/web-clients-forwarding.md`).
 */
import type { Hono } from "hono";
import { rolloutAnswerWithoutPostHog } from "../../utils/feature-flag-source.js";
import { WEB_CLIENTS_FEATURE_FLAG } from "@/shared/web-clients";
import { createDefaultWebAccountRoutes } from "./account-routes-default.js";
import { webClientService } from "./backend-connector-resolver.js";
import { createHostedWebClientEnvironmentFactory } from "./hosted-web-client-runtime.js";
import { createLocalWebClientEnvironmentFactory } from "./local-web-client-environment.js";
import { createHostedWebRecovery } from "./recovery/hosted-recovery.js";
import { setWebRecovery } from "./recovery/turn-recovery.js";
import {
  setWebClientEnvironment,
  webClientTurnsRunHosted,
} from "./web-client-environment.js";

export function mountWebClientRuntime(
  app: Hono,
  options: { hosted: boolean; flagOn?: () => boolean } = {
    hosted: webClientTurnsRunHosted(),
  },
): void {
  app.route("/api/web-clients", createDefaultWebAccountRoutes());
  if (options.hosted) {
    const service = webClientService();
    setWebClientEnvironment(createHostedWebClientEnvironmentFactory(service ? { service } : {}));
    setWebRecovery(service ? createHostedWebRecovery(service) : undefined);
    return;
  }
  const flagOn = options.flagOn ?? (() => rolloutAnswerWithoutPostHog(WEB_CLIENTS_FEATURE_FLAG) === true);
  if (flagOn()) setWebClientEnvironment(createLocalWebClientEnvironmentFactory());
}
