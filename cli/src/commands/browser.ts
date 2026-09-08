/**
 * `mcpjam browser` — an outside coding agent driving this machine's browser.
 *
 * The same session the Inspector's rail shows: an agent acts, a person can take
 * control, and both can read what happened. Every command goes through the
 * local Inspector's `/api/mcp/computers/local-browser/*` routes, which is the
 * transport `mcpjam inspector open` already uses — so the CLI inherits the
 * session token, the verified sign-in and the device consent rather than
 * inventing a second way in.
 *
 * Two shapes are deliberate here and worth naming:
 *
 *   - A SCREENSHOT COMES BACK AS A FILE PATH, never as inline base64. A
 *     hundred kilobytes of JPEG in a terminal (or in an agent's context
 *     window) is not a picture anybody can use, and `--inline` exists for the
 *     caller who genuinely wants the bytes.
 *   - AN ACT FOLDS ITS OBSERVATION IN. `--observe-after` defaults to `a11y`,
 *     so the refs for the next act come back with this one — one round trip,
 *     one ledger row, and no window in which the page moves between an act and
 *     the observation that was supposed to describe it.
 */
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fetchInspectorSessionToken,
  InspectorApiClient,
  normalizeInspectorBaseUrl,
} from "../lib/inspector-api.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { operationalError, usageError, writeResult } from "../lib/output.js";
import {
  forgetSession,
  getBrowserStateFilePath,
  readBrowserState,
  rememberSession,
  writeBrowserState,
} from "../lib/browser-session-store.js";

const LOCAL_CONSENT_HEADER = "x-mcpjam-local-consent";
const BROWSER_ROUTE = "/api/mcp/computers/local-browser";

/** How this CLI names itself in the ledger. See the door's actor rules. */
const CLIENT_KIND = "cli";

interface CommonOptions {
  inspectorUrl?: unknown;
  project?: unknown;
  session?: unknown;
  consent?: unknown;
  clientId?: unknown;
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--inspector-url <url>", "Local Inspector base URL")
    .option("--project <id>", "Project whose browser to drive", "default")
    .option("--session <id>", "Browser session id (defaults to the last opened)")
    .option(
      "--consent <token>",
      "Local computer consent capability (defaults to the stored one)",
    )
    .option(
      "--client-id <id>",
      "How this client appears in the session trace",
      "mcpjam-cli",
    );
}

function projectOf(options: CommonOptions): string {
  return typeof options.project === "string" && options.project.trim()
    ? options.project.trim()
    : "default";
}

/**
 * The consent capability, from the flag, the environment, or what a person
 * granted in the UI.
 *
 * Never minted here. The Inspector's consent screen is where a human
 * authorizes the agent browser, and a CLI that could grant itself the
 * capability would be that screen's own bypass — so a missing one is an error
 * that says where to get it, not a prompt this command answers for itself.
 */
function consentOf(options: CommonOptions): string {
  if (typeof options.consent === "string" && options.consent.trim()) {
    return options.consent.trim();
  }
  const fromEnv = process.env.MCPJAM_LOCAL_CONSENT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const stored = readBrowserState(getBrowserStateFilePath()).consent;
  if (stored) return stored;
  throw operationalError(
    "This machine's browser has not been authorized for the CLI.",
    "Open the Inspector, allow the local computer, then run " +
      "`mcpjam browser consent --token <capability>` (or set " +
      "MCPJAM_LOCAL_CONSENT). The CLI never grants this itself — the consent " +
      "screen is where a person authorizes the agent browser.",
  );
}

/** The session for this project: explicit, else the last one opened here. */
function sessionOf(options: CommonOptions, projectId: string): string {
  if (typeof options.session === "string" && options.session.trim()) {
    return options.session.trim();
  }
  const stored = readBrowserState(getBrowserStateFilePath()).sessions?.[
    projectId
  ];
  if (stored) return stored;
  throw usageError(
    `No open browser session for project \`${projectId}\`.`,
    "Run `mcpjam browser open` first, or pass --session <id>.",
  );
}

async function post(
  options: CommonOptions,
  path: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const client = new InspectorApiClient({
    baseUrl: normalizeInspectorBaseUrl(
      typeof options.inspectorUrl === "string" ? options.inspectorUrl : undefined,
    ),
  });
  const result = await client.request(`${BROWSER_ROUTE}${path}`, {
    method: "POST",
    body,
    headers: { [LOCAL_CONSENT_HEADER]: consentOf(options) },
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return (result ?? {}) as Record<string, unknown>;
}

/** Fields every command sends so the door can attribute the row. */
function identity(options: CommonOptions): Record<string, unknown> {
  return {
    client: CLIENT_KIND,
    clientId:
      typeof options.clientId === "string" ? options.clientId : "mcpjam-cli",
  };
}

/**
 * Turn a result's screenshot artifact into a file on disk.
 *
 * The design's rule, and the reason for it: an inline base64 screenshot is a
 * hundred kilobytes of noise in a terminal and in an agent's context window
 * alike, and neither can look at it. A path can be opened.
 */
async function saveScreenshot(
  options: CommonOptions,
  projectId: string,
  sessionId: string,
  page: unknown,
  outDir?: string,
): Promise<string | undefined> {
  const artifact = (
    page as {
      artifacts?: { screenshot?: { id?: string; mediaType?: string } };
    }
  )?.artifacts?.screenshot;
  if (!artifact?.id) return undefined;
  const baseUrl = normalizeInspectorBaseUrl(
    typeof options.inspectorUrl === "string" ? options.inspectorUrl : undefined,
  );
  // Its OWN fetch, rather than the shared `request` helper, and for a reason
  // that is easy to get wrong: that helper reads every response with
  // `response.text()`, which decodes as UTF-8 and replaces every invalid
  // sequence with U+FFFD. A JPEG read that way is not a slightly damaged JPEG,
  // it is a file that will not open — and nothing would say so.
  const token = await fetchInspectorSessionToken(baseUrl);
  const response = await fetch(`${baseUrl}${BROWSER_ROUTE}/artifact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MCP-Session-Auth": `Bearer ${token}`,
      [LOCAL_CONSENT_HEADER]: consentOf(options),
    },
    body: JSON.stringify({
      projectId,
      sessionId,
      artifactId: artifact.id,
      mediaType: artifact.mediaType ?? "image/jpeg",
    }),
  });
  if (!response.ok) return undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  const file = join(
    outDir ?? tmpdir(),
    `mcpjam-browser-${artifact.id}${extensionFor(artifact.mediaType)}`,
  );
  await writeFile(file, buffer);
  return file;
}

function extensionFor(mediaType: string | undefined): string {
  return mediaType && !mediaType.startsWith("image/") ? ".txt" : ".jpg";
}

export function registerBrowserCommands(program: Command): void {
  const browser = program
    .command("browser")
    .description("Drive this machine's browser and read its session trace");

  // ---- consent ----------------------------------------------------------
  browser
    .command("consent")
    .description("Store the local computer capability granted in the Inspector")
    .requiredOption("--token <token>", "The capability the Inspector showed once")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const file = getBrowserStateFilePath();
      const state = readBrowserState(file);
      await writeBrowserState(file, { ...state, consent: String(options.token) });
      writeResult(
        { success: true, stored: file },
        globalOptions.format,
      );
    });

  // ---- open -------------------------------------------------------------
  addCommonOptions(
    browser
      .command("open")
      .description("Open (or attach to) this project's browser session"),
  )
    .option(
      "--mode <mode>",
      "Session policy: allow_all | read_only | allowlist",
      "allow_all",
    )
    .option("--origin <origin...>", "Origins this session may visit")
    .option("--tool <op...>", "Operations this session may use")
    .option("--profile <profile>", "persistent | ephemeral", "persistent")
    .option("--attach <mode>", "prefer | never | require", "prefer")
    .option("--observe <mode>", "Initial observation: a11y | screenshot | none")
    .option(
      "--no-screenshots",
      "Keep a ledger without pictures for this session",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const projectId = projectOf(options);
      const body = await post(
        options,
        "/session",
        {
          projectId,
          attach: options.attach,
          profile: options.profile,
          policy: {
            mode: options.mode,
            ...(Array.isArray(options.origin) && options.origin.length
              ? { originAllowlist: options.origin }
              : {}),
            ...(Array.isArray(options.tool) && options.tool.length
              ? { toolAllowlist: options.tool }
              : {}),
          },
          ...(options.screenshots === false ? { captureScreenshots: false } : {}),
          ...(options.observe ? { observe: options.observe } : {}),
          ...identity(options),
        },
        globalOptions.timeout,
      );
      const session = body.session as { sessionId?: string } | undefined;
      if (session?.sessionId) {
        // So the next command does not need `--session`. Convenience only:
        // an explicit flag always wins.
        await rememberSession(
          getBrowserStateFilePath(),
          projectId,
          session.sessionId,
        );
      }
      writeResult({ success: true, ...body }, globalOptions.format);
    });

  // ---- observe ----------------------------------------------------------
  addCommonOptions(
    browser.command("observe").description("Look at the page"),
  )
    .option(
      "--mode <mode>",
      "a11y | screenshot | text | dom | console | url | page_tools",
      "a11y",
    )
    .option("--root-ref <ref>", "Scope an a11y tree to a ref")
    .option("--root-selector <selector>", "Scope an a11y tree to a selector")
    .option("--filter <filter>", "interactive | all")
    .option("--tab <tabId>", "Which tab to observe")
    .option("--out-dir <dir>", "Where to write a screenshot")
    .option("--inline", "Return screenshot bytes instead of a file path")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const projectId = projectOf(options);
      const sessionId = sessionOf(options, projectId);
      const result = await post(
        options,
        "/command",
        {
          projectId,
          sessionId,
          ...(options.tab ? { tabId: options.tab } : {}),
          command: {
            op: "observe",
            mode: options.mode,
            ...(options.rootRef ? { rootRef: options.rootRef } : {}),
            ...(options.rootSelector
              ? { rootSelector: options.rootSelector }
              : {}),
            ...(options.filter ? { filter: options.filter } : {}),
          },
          ...identity(options),
        },
        globalOptions.timeout,
      );
      await emit(result, {
        options,
        projectId,
        sessionId,
        format: globalOptions.format,
        saveScreenshots: options.mode === "screenshot" && !options.inline,
        outDir: typeof options.outDir === "string" ? options.outDir : undefined,
      });
    });

  // ---- navigate ---------------------------------------------------------
  addCommonOptions(
    browser
      .command("navigate <url>")
      .description("Go to a URL, returning the page it landed on"),
  )
    .option("--new-tab", "Open in a new tab")
    .option("--tab <tabId>", "Which tab to navigate")
    .option(
      "--command-id <id>",
      "Idempotency key: reuse it to retry safely after a transport failure",
    )
    .option(
      "--observe-after <mode>",
      "a11y | screenshot | none",
      "a11y",
    )
    .action(async (url, options, command) => {
      const globalOptions = getGlobalOptions(command);
      const projectId = projectOf(options);
      const sessionId = sessionOf(options, projectId);
      const result = await post(
        options,
        "/command",
        {
          projectId,
          sessionId,
          ...(options.tab ? { tabId: options.tab } : {}),
          ...(options.commandId ? { commandId: options.commandId } : {}),
          command: {
            op: "navigate",
            url,
            ...(options.newTab ? { newTab: true } : {}),
            observeAfter: options.observeAfter,
          },
          ...identity(options),
        },
        globalOptions.timeout,
      );
      await emit(result, {
        options,
        projectId,
        sessionId,
        format: globalOptions.format,
        saveScreenshots: options.observeAfter === "screenshot",
        outDir: typeof options.outDir === "string" ? options.outDir : undefined,
      });
    });

  // ---- act --------------------------------------------------------------
  addCommonOptions(
    browser
      .command("act")
      .description("Click, type, press, scroll, hover, drag, select, or move tabs"),
  )
    .requiredOption(
      "--verb <verb>",
      "click | type | press | scroll | hover | drag | select | close_tab | activate_tab",
    )
    .option("--ref <ref>", "Target a ref from the last a11y observation")
    .option("--selector <selector>", "Target a CSS selector")
    .option("--x <x>", "Target x, in the 1024x768 observation viewport")
    .option("--y <y>", "Target y, in the 1024x768 observation viewport")
    .option("--value <value>", "Text to type, key to press, option to select")
    .option("--expected-state <token>", "Refuse if the page has moved since")
    .option("--tab <tabId>", "Which tab to act on")
    .option(
      "--command-id <id>",
      "Idempotency key: reuse it to retry safely after a transport failure",
    )
    .option(
      "--observe-after <mode>",
      "a11y | screenshot | none",
      "a11y",
    )
    .option("--out-dir <dir>", "Where to write a screenshot")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const projectId = projectOf(options);
      const sessionId = sessionOf(options, projectId);
      const result = await post(
        options,
        "/command",
        {
          projectId,
          sessionId,
          ...(options.tab ? { tabId: options.tab } : {}),
          ...(options.commandId ? { commandId: options.commandId } : {}),
          command: {
            op: "act",
            verb: options.verb,
            ...(targetFrom(options) ? { target: targetFrom(options) } : {}),
            ...(options.value === undefined ? {} : { value: options.value }),
            ...(options.expectedState
              ? { expectedState: options.expectedState }
              : {}),
            observeAfter: options.observeAfter,
          },
          ...identity(options),
        },
        globalOptions.timeout,
      );
      await emit(result, {
        options,
        projectId,
        sessionId,
        format: globalOptions.format,
        saveScreenshots: options.observeAfter === "screenshot",
        outDir: typeof options.outDir === "string" ? options.outDir : undefined,
      });
    });

  // ---- note -------------------------------------------------------------
  addCommonOptions(
    browser
      .command("note <text>")
      .description("Write a marker into the session trace"),
  ).action(async (text, options, command) => {
    const globalOptions = getGlobalOptions(command);
    const projectId = projectOf(options);
    const sessionId = sessionOf(options, projectId);
    const body = await post(
      options,
      "/note",
      { projectId, sessionId, text, ...identity(options) },
      globalOptions.timeout,
    );
    writeResult({ success: true, ...body }, globalOptions.format);
  });

  // ---- trace ------------------------------------------------------------
  addCommonOptions(
    browser
      .command("trace")
      .description("Read this session's command history"),
  )
    .option("--after-seq <seq>", "Only rows after this seq")
    .option("--command-id <id>", "Find one command's row")
    .option("--limit <n>", "How many rows", "100")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const projectId = projectOf(options);
      const sessionId = sessionOf(options, projectId);
      const body = await post(
        options,
        "/trace",
        {
          projectId,
          sessionId,
          ...(options.afterSeq === undefined
            ? {}
            : { afterSeq: Number(options.afterSeq) }),
          ...(options.commandId ? { commandId: options.commandId } : {}),
          limit: Number(options.limit),
        },
        globalOptions.timeout,
      );
      writeResult({ success: true, ...body }, globalOptions.format);
    });

  // ---- close ------------------------------------------------------------
  addCommonOptions(
    browser
      .command("close")
      .description("Leave the session; --terminate closes the browser too"),
  )
    .option(
      "--terminate",
      "Close the browser itself, not just this participant",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const projectId = projectOf(options);
      const sessionId = sessionOf(options, projectId);
      const body = await post(
        options,
        "/close",
        {
          projectId,
          sessionId,
          ...(options.terminate ? { terminate: true } : {}),
          ...identity(options),
        },
        globalOptions.timeout,
      );
      await forgetSession(getBrowserStateFilePath(), projectId);
      writeResult({ success: true, ...body }, globalOptions.format);
    });
}

/** Read the three target shapes off the flags, refusing an ambiguous pair. */
function targetFrom(options: {
  ref?: unknown;
  selector?: unknown;
  x?: unknown;
  y?: unknown;
}): Record<string, unknown> | undefined {
  const named = [
    typeof options.ref === "string" && options.ref ? "ref" : null,
    typeof options.selector === "string" && options.selector ? "selector" : null,
    options.x !== undefined || options.y !== undefined ? "coordinates" : null,
  ].filter(Boolean);
  if (named.length === 0) return undefined;
  if (named.length > 1) {
    // Picking one silently would aim the click somewhere the caller did not
    // ask for, which looks exactly like a click that missed.
    throw usageError(
      `Give one target, not ${named.length}: ${named.join(", ")}.`,
    );
  }
  if (typeof options.ref === "string" && options.ref) return { ref: options.ref };
  if (typeof options.selector === "string" && options.selector) {
    return { selector: options.selector };
  }
  const x = Number(options.x);
  const y = Number(options.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw usageError("--x and --y must both be numbers.");
  }
  return { coordinates: [x, y] };
}

/**
 * Write out one command result.
 *
 * The `historyWarning` is surfaced rather than folded into the payload: it
 * means the command ran but its row could not be written, and a caller reading
 * a trace afterwards would otherwise find a hole with nothing to explain it.
 */
async function emit(
  result: Record<string, unknown>,
  context: {
    options: CommonOptions;
    projectId: string;
    sessionId: string;
    format: "json" | "human";
    saveScreenshots: boolean;
    outDir?: string;
  },
): Promise<void> {
  let screenshotPath: string | undefined;
  if (context.saveScreenshots) {
    const page =
      (result.page as unknown) ??
      ((result.refusal as { page?: unknown } | undefined)?.page as unknown);
    screenshotPath = await saveScreenshot(
      context.options,
      context.projectId,
      context.sessionId,
      page,
      context.outDir,
    ).catch(() => undefined);
  }
  writeResult(
    {
      ...envelopeFor(result),
      ...(screenshotPath ? { screenshotPath } : {}),
    },
    context.format,
  );
}

/**
 * The envelope a command result is written as.
 *
 * `success` is the field a shell script branches on, so it has to mean what a
 * script would assume: `executed` says the command RAN, and `ok` separately
 * says whether it SUCCEEDED. A click that found no button ran fine and failed,
 * and reporting that as a success is how a script carries on as though the
 * form were submitted.
 */
function envelopeFor(result: Record<string, unknown>): Record<string, unknown> {
  return {
    success: result.status === "executed" && result.ok !== false,
    ...result,
  };
}

/** Test seam for `envelopeFor`; see `tests/browser-command.test.ts`. */
export function emitForTests(result: Record<string, unknown>): {
  success: boolean;
} {
  return envelopeFor(result) as { success: boolean };
}
