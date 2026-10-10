/**
 * A telemetry-enabled page built from the app's REAL telemetry modules —
 * posthog-js with the app's options and bundled recorder, Sentry with the
 * app's init, the session privacy hook, the capture-context stamp and the
 * identity grant — showing synthetic personal data. The spec
 * (e2e/telemetry-privacy.browser.ts) intercepts both transports and decodes
 * what would have left the browser.
 *
 * `?privacy=masked` is a member viewing an organization with enterprise
 * privacy; `?privacy=full` is a verified non-private context, the positive
 * control that proves the recorders were capturing all along.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { getPostHogKey, getPostHogOptions } from "@/lib/PosthogUtils";
import { preloadPosthogBundledExtensions } from "@/lib/posthog-bundled-extensions";
import { initSentry, syncSentryReplay } from "@/lib/sentry";
import { setSentryActor } from "@/lib/sentry-identity";
import {
  recordingSurface,
  resolveSessionPrivacy,
  syncSessionRecording,
} from "@/lib/session-privacy";
import {
  setTelemetryActor,
  setTelemetryCaptureContext,
  setTelemetryIdentity,
} from "@/lib/telemetry-context";
import { useSessionPrivacy } from "@/hooks/useSessionPrivacy";
import { SYNTHETIC_PII } from "@/shared/__tests__/fixtures/telemetry-pii";
import {
  HARNESS_ACTOR_ID,
  HARNESS_PRIVATE_ORG,
  HARNESS_PUBLIC_ORG,
  HARNESS_RELAY_TOKEN,
} from "./constants";

const mode =
  new URLSearchParams(window.location.search).get("privacy") === "full"
    ? "full"
    : "masked";

function Harness() {
  useSessionPrivacy(
    resolveSessionPrivacy({
      surface: recordingSurface(),
      sharedLink: false,
      recording: mode,
    }),
  );
  return (
    <main className="harness-shell">
      <header className="harness-header">
        <h1 className="harness-title" title={SYNTHETIC_PII.title}>
          {SYNTHETIC_PII.domText}
        </h1>
      </header>
      <section className="harness-card" data-state="open">
        <p className="harness-org">{SYNTHETIC_PII.organizationName}</p>
        <a
          className="harness-link"
          href={`/servers/${SYNTHETIC_PII.serverName}`}
          onClick={(event) => event.preventDefault()}
        >
          {SYNTHETIC_PII.serverName}
        </a>
        <img
          className="harness-avatar"
          src={SYNTHETIC_PII.imageUrl}
          alt={SYNTHETIC_PII.name}
          width={32}
          height={32}
        />
        <input
          className="harness-input"
          data-testid="pii-input"
          placeholder={SYNTHETIC_PII.placeholder}
        />
        <button
          type="button"
          className="harness-button"
          data-testid="harness-button"
        >
          Open invoices for {SYNTHETIC_PII.name}
        </button>
      </section>
    </main>
  );
}

async function boot() {
  initSentry();
  await preloadPosthogBundledExtensions();
  posthog.init(getPostHogKey(), {
    ...getPostHogOptions(),
    // The one departure from the app's options: posthog-js drops every
    // capture from a webdriver-controlled or headless browser, which is
    // exactly what runs this page.
    opt_out_useragent_filter: true,
  });
  // What usePostHogRelayAuth does with a real bearer.
  posthog.set_config({
    request_headers: { Authorization: `Bearer ${HARNESS_RELAY_TOKEN}` },
  });

  setTelemetryActor(HARNESS_ACTOR_ID);
  if (mode === "full") setTelemetryIdentity(HARNESS_ACTOR_ID, "full");
  setSentryActor({
    kind: "signedIn",
    id: HARNESS_ACTOR_ID,
    email: SYNTHETIC_PII.email,
    name: SYNTHETIC_PII.name,
  });
  setTelemetryCaptureContext({
    projectIds: [],
    organizationIds: [
      mode === "full" ? HARNESS_PUBLIC_ORG : HARNESS_PRIVATE_ORG,
    ],
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <PostHogProvider client={posthog}>
        <Harness />
      </PostHogProvider>
    </StrictMode>,
  );

  const harness = {
    ready: true,
    mode,
    posthog,
    sessionId: () => posthog.get_session_id(),
    log: () => console.log(SYNTHETIC_PII.consoleMessage),
    fetchNetwork: async () => {
      await fetch(SYNTHETIC_PII.networkUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: SYNTHETIC_PII.networkBody,
      });
    },
    // A caller that sends names regardless; the stamp must strip them
    // while identity is id-only.
    identifyWithNames: () =>
      posthog.identify(HARNESS_ACTOR_ID, {
        email: SYNTHETIC_PII.email,
        name: SYNTHETIC_PII.name,
      }),
    capture: () => posthog.capture("harness_event", { step: "capture" }),
    fail: () => {
      setTimeout(() => {
        throw new Error("telemetry harness failure");
      });
    },
    goTo: (path: string) => {
      window.history.pushState({}, "", path);
      syncSessionRecording(posthog, path);
      syncSentryReplay(path);
      posthog.capture("harness_navigated", { step: "navigated" });
    },
  };
  (window as unknown as { __harness: typeof harness }).__harness = harness;
}

void boot();
