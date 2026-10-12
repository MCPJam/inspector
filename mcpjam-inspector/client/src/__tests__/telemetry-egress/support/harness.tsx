/**
 * The app's telemetry, booted for real inside jsdom: the same SDKs, the same
 * options, the same order as `app-bootstrap.tsx`, the same hooks — with the
 * network replaced by a recorder (`jsdom-network.ts`).
 *
 * What is real here, and why each piece matters to the proof:
 *
 *  - `initSentry()` with the app's config, `installRecorderNavigationGuard()`
 *    after it (so the guard is the outermost `pushState` wrapper, as in the
 *    app), and `preloadPosthogBundledExtensions()` before posthog-js inits,
 *    which is what puts the replay recorder in this process at all.
 *  - `<PostHogProvider apiKey options>` with `getPostHogOptions()`, so the
 *    `before_send` chain, `disable_capture_url_hashes` and the masked init
 *    profile are the shipped ones.
 *  - `useSessionPrivacy` and `useSessionRecordingPathGuard`, the two hooks
 *    that start, switch and resume both recorders, under a real react-router
 *    data router registered with `setAppRouter` — the path guard resumes
 *    recording from `router.subscribe`, exactly as in the app.
 *
 * What is stood in for, and why:
 *
 *  - The page. One route that renders what a share page renders: its own
 *    address (text and a "Copy link" `href`), share links as text, `href` and
 *    iframe `src`, an input holding a secret, a button. On a credential route
 *    it also shows the secret BARE, as an access-key reveal or a shared chat
 *    would show content no URL scrubber can recognise — the registry's
 *    promise for those pages is that they are never recorded, so nothing on
 *    them may reach a payload. The app's real pages need Convex and WorkOS;
 *    the Playwright job drives those.
 *  - `__SENTRY_BROWSER_BUNDLE__`. Sentry decides "am I in a browser?" by
 *    asking whether `process` exists, and under vitest it does, so Replay
 *    would silently never set up. The flag is Sentry's own switch for "this
 *    is a browser bundle", which the shipped client is.
 *  - `Math.random`, pinned low and deterministic: Sentry's replay session
 *    sample rate (0.1) and trace sample rate (0.1) are the app's; pinning the
 *    draw picks the sampled branch every run instead of one run in ten.
 *
 * jsdom cannot run PostHog's network plugin (it reads `PerformanceObserver`
 * resource entries jsdom never produces) or Sentry's compression worker.
 * Both run in the Playwright job (`e2e/telemetry/`).
 */
import { act, createContext, useContext, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createBrowserRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "react-router";
import { vi } from "vitest";
import {
  posthogRemoteConfigScript,
  scanAll,
  SENTINEL_STEM,
  sentinel,
  sinkOf,
  type CapturedRequest,
} from "../../../../../e2e/telemetry/egress";
import {
  installNetworkStub,
  type NetworkStub,
  type ScriptResponse,
  type StubResponse,
} from "./jsdom-network";

export type SessionPrivacy = "full" | "masked" | "pending" | "off";

/** A normal, recordable page: a project's servers screen, ids only. */
export const NORMAL_PAGE = "/p/k17abc0123456789abcdefghij/servers";

/** What the PostHog relay, Sentry ingest and the app's API answer. */
function respond(
  request: CapturedRequest,
): StubResponse | ScriptResponse | null {
  const url = new URL(request.url);
  const sink = sinkOf(request.url);
  if (sink === "posthog") {
    if (/\/array\/[^/]+\/config\.js$/.test(url.pathname)) {
      const script = posthogRemoteConfigScript();
      // `new Function` is the jsdom stand-in for the browser executing the
      // script response: the same text Playwright fulfils, the same effect.
      return { run: () => new Function(script)() };
    }
    if (url.pathname.includes("/flags")) {
      return { body: JSON.stringify({ featureFlags: {}, flags: {} }) };
    }
    return { body: JSON.stringify({ status: 1 }) };
  }
  return { body: "{}" };
}

// ── The page ───────────────────────────────────────────────────────────

/** Share links on screen, swappable without a remount. */
const shareLinkStore = (() => {
  let links: readonly string[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => links,
    set(next: readonly string[]) {
      links = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

/**
 * Text, link and frame for every credential URL, absolute on this origin —
 * what a share dialog, a results list or the Preview pane shows. Annotated
 * nowhere: the full profile's text and attribute callbacks must catch these
 * by content, not by an attribute someone remembered to add.
 */
function ShareLinks() {
  const urls = useSyncExternalStore(
    shareLinkStore.subscribe,
    shareLinkStore.get,
  );
  if (urls.length === 0) return null;
  return (
    <section id="share-links">
      {urls.map((url) => {
        const absolute = new URL(url, window.location.origin).toString();
        return (
          <p key={url}>
            Share link: {absolute}{" "}
            <a href={absolute} title={`Open ${absolute}`}>
              open
            </a>
          </p>
        );
      })}
      <iframe
        title="preview"
        src={new URL(urls[0], window.location.origin).toString()}
      />
    </section>
  );
}

/** The sentinel in the current location, if any — the page's own secret. */
function bareSecret(location: {
  pathname: string;
  search: string;
  hash: string;
}): string | null {
  const match = new RegExp(`${SENTINEL_STEM}[a-z]+`, "i").exec(
    `${location.pathname}${location.search}${location.hash}`,
  );
  return match ? match[0] : null;
}

function Page() {
  const location = useLocation();
  const here = `${window.location.origin}${location.pathname}${location.search}${location.hash}`;
  const secret = bareSecret(location);
  return (
    <main>
      <h1 id="where">Viewing {here}</h1>
      <a id="self-link" href={here}>
        Copy link
      </a>
      {secret ? (
        <p id="page-secret">
          Token <code>{secret}</code>
        </p>
      ) : null}
      <ShareLinks />
      <label>
        Access key
        <input id="secret-input" defaultValue={sentinel("inputvalue")} />
      </label>
      <button id="action" type="button" title="Run the thing">
        Run
      </button>
    </main>
  );
}

// ── The harness ────────────────────────────────────────────────────────

export interface TelemetryHarness {
  network: NetworkStub;
  posthog: typeof import("posthog-js").default;
  Sentry: typeof import("@sentry/react");
  /** Re-render with a new resolved level, as `App` does when it changes. */
  setLevel(level: SessionPrivacy): Promise<void>;
  /** Put share links on screen (or take them off with `[]`). */
  showShareLinks(urls: readonly string[]): Promise<void>;
  /** In-app navigation: `router.navigate`, through the guard. */
  navigate(to: string): Promise<void>;
  /**
   * A fragment change (`location.hash = …`): not a router navigation but a
   * `hashchange` + `popstate`, which the guard's capture-phase listeners and
   * react-router's history listener both see. Inside `act` so React renders
   * it as promptly as a browser would.
   */
  setHash(hash: string): Promise<void>;
  /** A user click (autocapture, rrweb mouse interaction, the flush hold). */
  click(selector?: string): Promise<void>;
  /** Let timers and microtasks run, inside `act`. */
  idle(ms?: number): Promise<void>;
  /**
   * Ship everything buffered: Sentry's replay segment and event queue via
   * their public `flush()`, PostHog's replay buffer and request queue via a
   * page unload (`beforeunload` + `pagehide`, then `pageshow` as a bfcache
   * restore so the page carries on).
   */
  flush(): Promise<void>;
  /** Fire `beforeunload` + `pagehide` only: what a closing tab sends. */
  unload(): Promise<void>;
  /** Decode and scan every request recorded since `mark`. */
  scanSince(mark: number): ReturnType<typeof scanAll>;
  /** Where the request log stands now, for `scanSince`. */
  mark(): number;
}

/** Deterministic, always below the app's 0.1 sample rates. */
function pinRandom() {
  let state = 0x2545f491;
  vi.spyOn(Math, "random").mockImplementation(() => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state / 0x7fffffff) * 0.05;
  });
}

export async function bootTelemetryHarness(): Promise<TelemetryHarness> {
  // Hosted mode is what records (`resolveSessionPrivacy`); the PostHog
  // opt-out and the Sentry kill switch must both be off, as in production.
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
  vi.stubEnv("VITE_DISABLE_SENTRY", "false");
  (globalThis as Record<string, unknown>).__SENTRY_BROWSER_BUNDLE__ = true;
  pinRandom();

  // Before ANY SDK module loads: both capture their transports at load.
  const network = installNetworkStub(respond);

  // app-bootstrap.tsx order: Sentry, then the guard, then the bundled
  // extensions, then the provider.
  const sentry = await import("@/lib/sentry");
  sentry.initSentry();
  const { installRecorderNavigationGuard } =
    await import("@/lib/recorder-navigation-guard");
  installRecorderNavigationGuard();
  const { preloadPosthogBundledExtensions } =
    await import("@/lib/posthog-bundled-extensions");
  await preloadPosthogBundledExtensions();

  const posthog = (await import("posthog-js")).default;
  const { PostHogProvider } = await import("posthog-js/react");
  const { getPostHogKey, getPostHogOptions } =
    await import("@/lib/PosthogUtils");
  const { useSessionPrivacy } = await import("@/hooks/useSessionPrivacy");
  const { useSessionRecordingPathGuard } =
    await import("@/hooks/useSessionRecordingPathGuard");
  const { setAppRouter } = await import("@/router-ref");
  const Sentry = await import("@sentry/react");

  // As in the app: the recorder hooks run in the router's ROOT element
  // (`App`), so the path guard sees the location React has committed. The
  // level comes in from outside the router, as it does from `App`'s state.
  const LevelContext = createContext<SessionPrivacy>("pending");
  function RecorderHooks() {
    useSessionPrivacy(useContext(LevelContext));
    useSessionRecordingPathGuard();
    return null;
  }
  function Shell() {
    return (
      <>
        <RecorderHooks />
        <Outlet />
      </>
    );
  }

  const router = createBrowserRouter([
    { element: <Shell />, children: [{ path: "*", element: <Page /> }] },
  ]);
  setAppRouter(router);

  // The provider's options must be one object across renders: it compares
  // them by value and a change would `set_config` the SDK again.
  const posthogOptions = getPostHogOptions();
  const tree = (level: SessionPrivacy) => (
    <PostHogProvider apiKey={getPostHogKey()} options={posthogOptions}>
      <LevelContext.Provider value={level}>
        <RouterProvider router={router} />
      </LevelContext.Provider>
    </PostHogProvider>
  );

  // A root of our own, not Testing Library's `render`: the suite's global
  // `afterEach(cleanup)` would unmount it between steps, and these steps are
  // one session. `pending` first, as the app renders while auth loads.
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(tree("pending"));
  });

  const idle = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const unload = async () => {
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
    });
    await network.settle();
  };

  return {
    network,
    posthog,
    Sentry,
    async setLevel(level) {
      await act(async () => {
        root.render(tree(level));
      });
      await idle();
    },
    async showShareLinks(urls) {
      await act(async () => {
        shareLinkStore.set(urls);
      });
      await idle();
    },
    async navigate(to) {
      await act(async () => {
        await router.navigate(to);
      });
      await idle();
    },
    async setHash(hash) {
      await act(async () => {
        window.location.hash = hash;
        // jsdom fires `hashchange`/`popstate` from a task, as browsers do.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await idle();
    },
    async click(selector = "#action") {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (!element) throw new Error(`no element for ${selector}`);
      await act(async () => {
        element.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );
        element.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
        );
        element.click();
      });
      await idle();
    },
    idle,
    async flush() {
      await idle(50);
      await act(async () => {
        await Sentry.getReplay()?.flush();
        await Sentry.flush(2_000);
      });
      await unload();
      await act(async () => {
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      });
      await idle(50);
      await network.settle();
    },
    unload,
    scanSince(mark) {
      return scanAll(network.since(mark));
    },
    mark() {
      return network.requests.length;
    },
  };
}
