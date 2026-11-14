/**
 * Backend → inspector: run the hosted-browser synthetic check once.
 *
 * The backend's hourly cron calls this and pages on a failed result. The
 * service token proves the caller is the backend. The `bearer` in the body is
 * the internal synthetic user, minted by the backend for this one run, and it
 * is what reserves and pays for the desktop: the check takes the same reserve
 * path and the same billing as a member opening the browser.
 *
 * The answer is 200 whenever the check ran, pass or fail, because the result
 * IS the answer. Only a request the check could not attempt gets another
 * status: 400 for a malformed body, 503 when this deployment cannot host a
 * browser at all.
 *
 * The live seams are the ones the WebMCP inspector's hosted start uses
 * (`ensureLiveBrowserSession`, `createBrowserdWebMcpProvider`,
 * `WebMcpSessionRuntime`). The orchestration and its teardown guarantee live
 * in `services/browserd/hosted-browser-synthetic.ts`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { internalServiceAuthMiddleware } from "../../middleware/internal-service-auth.js";
import {
  runHostedBrowserSynthetic,
  type SyntheticDeps,
  type SyntheticPage,
  type SyntheticResult,
} from "../../services/browserd/hosted-browser-synthetic.js";
import { ensureLiveBrowserSession } from "../../services/browserd/live-session-deps.js";
import type { ComputerHostedBrowserSessionHandle } from "../../services/browserd/browser-session.js";
import { createBrowserdWebMcpProvider } from "../../services/webmcp-inspector/browserd-provider.js";
import { WebMcpSessionRuntime } from "../../services/webmcp-inspector/session-runtime.js";
import {
  ensureComputerReady,
  isComputersDataPlaneConfigured,
} from "../../utils/computers/control-plane-client.js";
import { convexDeleteDesktopComputer } from "../../utils/computers/convex-environment-client.js";
import { isHostedDesktopUnavailable } from "../../utils/computers/runtime-config.js";
import { logger } from "../../utils/logger.js";
import {
  syntheticPageUrl,
  type SyntheticPageVariant,
} from "../synthetic-webmcp-page.js";

const bodySchema = z.object({
  projectId: z.string().min(1),
  bearer: z.string().min(1),
  /** `empty` opens a page with no tools, to force a failure on purpose. */
  page: z.enum(["tools", "empty"]).optional(),
});

/** The page to open, or what this deployment lacks to run the check. */
function configFor(
  page: SyntheticPageVariant,
): { url: string } | { missing: string } {
  if (!isComputersDataPlaneConfigured()) {
    return { missing: "the computers data plane is not configured" };
  }
  if (isHostedDesktopUnavailable()) {
    return { missing: "the backend reports no desktop template or rate" };
  }
  if (!process.env.CONVEX_URL?.trim()) {
    return { missing: "CONVEX_URL is not set, so no desktop could be deleted" };
  }
  const url = syntheticPageUrl(page);
  return url
    ? { url }
    : { missing: "no public HTTPS URL a cloud desktop can load the page from" };
}

async function openWebMcpPage(
  handle: ComputerHostedBrowserSessionHandle,
  url: string,
): Promise<SyntheticPage> {
  const runtime = new WebMcpSessionRuntime(url);
  // No poll: the check reads the tools on demand, and a timer left running
  // against a desktop the teardown is about to delete would only log failures.
  const provider = createBrowserdWebMcpProvider({ handle, toolPollMs: 0 });
  const session = await provider.createSession({
    url,
    callbacks: runtime.callbacks(),
  });
  runtime.attach(session);
  return {
    countTools: async () => {
      await runtime.refreshTools();
      return runtime.currentTools().length;
    },
    close: () => runtime.close("detached"),
  };
}

function liveDeps(bearer: string, projectId: string): SyntheticDeps {
  return {
    reserve: async (signal) => {
      // Reserved here as well as inside `ensureLiveBrowserSession` so a slow
      // or refused provision reports as `reserve`, not as `boot`. The second
      // reserve finds the desktop ready and returns at once.
      const reserved = await ensureComputerReady({
        bearer,
        projectId,
        runtimeKind: "desktop-browser",
        signal,
      });
      if (!reserved.ok) {
        throw new Error(
          `reserve failed (${reserved.status}): ${reserved.error}`,
        );
      }
    },
    boot: async (signal) => {
      const handle = await ensureLiveBrowserSession({
        bearer,
        projectId,
        // An ephemeral profile is refused on a project computer, and the
        // teardown deletes this one, profile and all.
        contextMode: "persistent",
        signal,
      });
      return { open: (url) => openWebMcpPage(handle, url) };
    },
    teardown: async () => {
      await convexDeleteDesktopComputer(bearer, projectId);
    },
  };
}

const internalHostedBrowserSynthetic = new Hono();

internalHostedBrowserSynthetic.use("*", internalServiceAuthMiddleware());

internalHostedBrowserSynthetic.post("/synthetic", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { ok: false, error: "projectId and bearer are required" },
      400,
    );
  }
  const { projectId, bearer } = parsed.data;
  const page = parsed.data.page ?? "tools";

  const config = configFor(page);
  if ("missing" in config) {
    const result: SyntheticResult = {
      ok: false,
      stage: "config",
      durationMs: 0,
      toolCount: 0,
      error: config.missing,
    };
    logger.warn("[hosted-browser-synthetic] cannot run here", {
      projectId,
      error: config.missing,
    });
    return c.json(result, 503);
  }

  const result = await runHostedBrowserSynthetic(liveDeps(bearer, projectId), {
    url: config.url,
  });
  // The bearer is never logged: it acts as the synthetic user until it expires.
  const context = { projectId, page, ...result };
  if (result.ok) {
    logger.info("[hosted-browser-synthetic] check passed", context);
  } else {
    logger.warn("[hosted-browser-synthetic] check failed", context);
  }
  return c.json(result, 200);
});

export default internalHostedBrowserSynthetic;
