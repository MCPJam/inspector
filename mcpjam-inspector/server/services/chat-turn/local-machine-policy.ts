import type { Context } from "hono";
import type { UIMessageChunk } from "ai";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";
import {
  classifyChatRequestActor,
  isGuestOrAnonymousRequest,
  isVerifiedMember,
  type ChatRequestActor,
} from "../../utils/computers/local-engine-request.js";
import { resolvePersonalComputerEngine } from "../../utils/computers/engine.js";
import {
  LOCAL_CONSENT_HEADER,
  verifyLocalComputerConsent,
} from "../../utils/computers/local-consent.js";
import {
  BROWSER_CONSENT_HEADER,
  verifyLocalBrowserConsent,
} from "../../utils/computers/browser-consent.js";
import { resolveBrowserEngine } from "../../utils/computers/browser-engine.js";
import { resolveBrowserRollout } from "../../utils/computers/browser-rollout.js";
import { isHostedBrowserAvailableFor } from "../../utils/computers/hosted-browser-availability.js";
import { resolveLocalBrowserRuntime } from "../browserd/local/local-browser-session.js";
import { isChromiumInstalled } from "../../utils/browser-rendering-setup.js";
import { BrowserSessionService } from "../browserd/session-service.js";

/** Consent and account checks for capabilities on the local Inspector machine. */
export async function resolveLocalMachinePolicy(args: {
  c: Context;
  body: {
    computerEngine?: unknown;
    browserEngine?: unknown;
    projectId?: string;
    chatSessionId?: string;
  };
  builtInToolIds?: string[];
  isScenarioSession: boolean;
  localBrowserSettingsUnavailable?: boolean;
}) {
  if (HOSTED_MODE)
    throw new Error("Local machine policy is unavailable on service replicas");
  const {
    c,
    body,
    isScenarioSession,
    localBrowserSettingsUnavailable = false,
  } = args;
  const resolvedExecution = { builtInToolIds: args.builtInToolIds };
  const requestAuthHeader = c.req.header("authorization");
  const builtInAuthHeader = requestAuthHeader;
  let actor: Promise<ChatRequestActor> | undefined;
  const requestActor = () =>
    (actor ??= classifyChatRequestActor(requestAuthHeader));
  const requestIsGuestOrAnonymous = () =>
    isGuestOrAnonymousRequest(requestAuthHeader);
  const rawEnginePref = body.computerEngine;
  const enginePref =
    rawEnginePref === "local" || rawEnginePref === "cloud"
      ? rawEnginePref
      : undefined;
  const requestIsGuest = await requestIsGuestOrAnonymous();
  const actorForEngine =
    enginePref === "local" && !isScenarioSession ? await requestActor() : null;
  const localPrefEligible =
    actorForEngine !== null && isVerifiedMember(actorForEngine);
  if (enginePref === "local" && !localPrefEligible) {
    logger.debug(
      "[mcp/chat-v2] computerEngine=local ignored for an ineligible request",
      { isScenarioSession, actorKind: actorForEngine?.kind ?? "scenario" },
    );
  }
  const localConsentValid = localPrefEligible
    ? await verifyLocalComputerConsent(c.req.header(LOCAL_CONSENT_HEADER))
    : false;
  if (localPrefEligible && !localConsentValid) {
    logger.warn(
      "[mcp/chat-v2] computerEngine=local without a valid consent capability; local engine unavailable for this turn",
    );
  }
  const computerEngine = resolvePersonalComputerEngine({
    ...(localPrefEligible
      ? { preference: "local" as const }
      : enginePref === "cloud"
        ? { preference: "cloud" as const }
        : {}),
    localConsentValid,
  });

  const localBrowserRequested = body.browserEngine === "local";
  const wantsBrowser =
    !localBrowserSettingsUnavailable &&
    resolvedExecution.builtInToolIds?.includes(BROWSER_BUILT_IN_TOOL_ID);
  const browserRollout = !wantsBrowser
    ? { enabled: false, actor: null }
    : localBrowserRequested
      ? await resolveBrowserRollout(c, true)
      : {
          enabled: await isHostedBrowserAvailableFor({
            bearer: requestAuthHeader,
            projectId:
              typeof body.projectId === "string" ? body.projectId : null,
            surface: "tools",
          }),
          actor: null,
        };
  const localBrowserGuestId =
    localBrowserRequested &&
    browserRollout.enabled &&
    browserRollout.actor?.guest
      ? browserRollout.actor.id
      : undefined;
  const browserConsentToken = c.req.header(BROWSER_CONSENT_HEADER);
  const browserActor =
    localBrowserRequested &&
    browserRollout.enabled &&
    !isScenarioSession &&
    !localBrowserGuestId
      ? await requestActor()
      : null;
  const browserMemberVerified =
    browserActor !== null && isVerifiedMember(browserActor);
  const browserConsentValid =
    browserRollout.enabled &&
    (browserMemberVerified || Boolean(localBrowserGuestId)) &&
    !isScenarioSession &&
    (await verifyLocalBrowserConsent(browserConsentToken));
  let browserEngine = resolveBrowserEngine({
    preference: localBrowserRequested ? "local" : "cloud",
    localConsentValid: browserConsentValid,
  });
  if (!browserRollout.enabled) browserEngine = "unavailable";
  let browserUnavailableReason = localBrowserSettingsUnavailable
    ? "browser_runtime_unavailable: Could not load local Browser settings. Retry your request."
    : !browserRollout.enabled
      ? "browser_rollout_unavailable: Browser is not available for this location."
      : localBrowserRequested && browserEngine !== "local"
        ? browserConsentValid
          ? "browser_runtime_unavailable: Browser on this machine is unavailable. Check Browser settings."
          : "browser_consent_required: Allow Browser in the Browser panel."
        : undefined;

  if (
    browserEngine === "local" &&
    resolveLocalBrowserRuntime() !== "electron" &&
    !(await isChromiumInstalled())
  ) {
    browserEngine = "unavailable";
    browserUnavailableReason =
      "browser_runtime_unavailable: Install Chromium in the Browser panel.";
  }
  if (
    !localBrowserGuestId &&
    body.browserEngine &&
    body.chatSessionId &&
    body.projectId &&
    builtInAuthHeader &&
    resolvedExecution.builtInToolIds?.includes(BROWSER_BUILT_IN_TOOL_ID) &&
    !browserUnavailableReason
  ) {
    try {
      const browserSessions = new BrowserSessionService();
      const location = await browserSessions.conversationLocation({
        conversationId: body.chatSessionId,
        projectId: body.projectId,
        bearer: builtInAuthHeader,
      });
      if (location && location !== (localBrowserRequested ? "local" : "cloud"))
        throw new Error("browser_location_mismatch");
    } catch (error) {
      browserEngine = "unavailable";
      browserUnavailableReason =
        error instanceof Error &&
        error.message.includes("browser_location_mismatch")
          ? "browser_location_mismatch: Start a new chat to change Browser location."
          : "browser_runtime_unavailable: Browser session could not be reached. Retry from the Browser panel.";
    }
  }

  const emitBrowserReadiness = (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => {
    if (
      !body.browserEngine ||
      !resolvedExecution.builtInToolIds?.includes(BROWSER_BUILT_IN_TOOL_ID)
    )
      return;
    writer.write({
      type: "data-browser-readiness",
      data: { reason: browserUnavailableReason ?? null },
    });
  };

  return {
    computerEngine,
    browserEngine,
    localBrowserGuestId,
    browserConsentToken,
    localBrowserRequested,
    browserUnavailableReason,
    localComputerRequested: localPrefEligible,
    requestIsGuest,
    emitBrowserReadiness,
  };
}
