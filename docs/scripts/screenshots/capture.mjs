#!/usr/bin/env node
// Screenshot capture harness for the MCPJam docs.
//
// Usage:
//   node docs/scripts/screenshots/capture.mjs [--only <id>] [--kind ui|terminal] [--tier A|B|C] [--list] [--validate]
//   node docs/scripts/screenshots/capture.mjs --login
//
// See docs/scripts/screenshots/README.md for the full workflow.

import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// docs/scripts/screenshots -> docs
const DOCS_ROOT = path.resolve(__dirname, "..", "..");
// docs -> repo root, where the built CLI lives
const REPO_ROOT = path.resolve(DOCS_ROOT, "..");
const MANIFEST_PATH = path.join(__dirname, "manifest.json");
const TERMINAL_TEMPLATE_PATH = path.join(__dirname, "terminal.html");
const CLI_ENTRY = path.join(REPO_ROOT, "cli", "dist", "index.js");

const execFileAsync = promisify(execFileCb);

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const STORAGE_STATE = process.env.STORAGE_STATE || null;

// Where `--login` writes the storage state it captures, and the path tier C
// runs are expected to point STORAGE_STATE at (see README.md). Gitignored at
// the repo root -- this file holds a live hosted-app session, not a fixture.
const LOGIN_BASE_URL = process.env.BASE_URL || "https://app.mcpjam.com";
const STORAGE_STATE_DIR = path.join(REPO_ROOT, ".screenshot-auth");
const STORAGE_STATE_OUTPUT_PATH = path.join(STORAGE_STATE_DIR, "state.json");

const VALID_KINDS = new Set(["ui", "terminal"]);
const VALID_TIERS = new Set(["A", "B", "C"]);

// The CLI switches to JSON output when stdout isn't a TTY (which it never is
// under execFile). These ids render structured results that only look right
// in "human" format (pretty-printed), so force it for the actual capture run.
// The displayed prompt/title still show the command as a user would type it.
const FORMAT_HUMAN_IDS = new Set([
  "cli-server-doctor",
  "cli-tools-list",
  "cli-apps-conformance",
  "cli-telemetry-status",
]);

const MCP_STDIO_READY_LINE = "MCPJam MCP server listening on stdio";
const MAX_OUTPUT_LINES = 48;

function parseArgs(argv) {
  const opts = {
    only: null,
    kind: null,
    tier: null,
    list: false,
    validate: false,
    login: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--only":
        opts.only = argv[++i];
        if (!opts.only) {
          throw new Error("--only requires an id argument");
        }
        break;
      case "--kind":
        opts.kind = argv[++i];
        if (!VALID_KINDS.has(opts.kind)) {
          throw new Error(`--kind must be one of ui|terminal (got: ${opts.kind})`);
        }
        break;
      case "--tier":
        opts.tier = argv[++i];
        if (!VALID_TIERS.has(opts.tier)) {
          throw new Error(`--tier must be one of A|B|C (got: ${opts.tier})`);
        }
        break;
      case "--list":
        opts.list = true;
        break;
      case "--validate":
        opts.validate = true;
        break;
      case "--login":
        opts.login = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.entries)) {
    throw new Error("manifest.json is missing an entries array");
  }
  return manifest;
}

function filterEntries(entries, opts) {
  return entries.filter((entry) => {
    if (opts.only && entry.id !== opts.only) return false;
    if (opts.kind && entry.kind !== opts.kind) return false;
    if (opts.tier && entry.tier !== opts.tier) return false;
    return true;
  });
}

// Checks the whole manifest (not just the filtered subset) so id collisions
// and structural problems are always caught, regardless of which entries
// were selected for this run.
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();

  for (const entry of manifest.entries) {
    const label = entry.id || "<missing id>";

    if (!entry.id) {
      errors.push(`${label}: missing id`);
    } else if (seenIds.has(entry.id)) {
      errors.push(`${label}: duplicate id`);
    } else {
      seenIds.add(entry.id);
    }

    if (!VALID_KINDS.has(entry.kind)) {
      errors.push(`${label}: kind must be "ui" or "terminal" (got: ${entry.kind})`);
    }

    if (!entry.page) {
      errors.push(`${label}: missing page`);
    } else {
      const pagePath = path.join(DOCS_ROOT, entry.page);
      if (!existsSync(pagePath)) {
        errors.push(`${label}: page file not found: ${entry.page}`);
      }
    }

    if (!entry.output) {
      errors.push(`${label}: missing output`);
    } else if (!entry.output.startsWith("docs/images/")) {
      errors.push(`${label}: output must be under docs/images/ (got: ${entry.output})`);
    }

    if (!entry.alt) {
      errors.push(`${label}: missing alt text`);
    } else if (/screenshot/i.test(entry.alt)) {
      errors.push(`${label}: alt text must not contain the word "screenshot"`);
    } else if (entry.alt.includes(String.fromCharCode(0x2014))) {
      errors.push(`${label}: alt text must not contain an em-dash`);
    }

    if (entry.kind === "ui") {
      if (!entry.route) {
        errors.push(`${label}: ui entries require a route`);
      } else if (entry.route.includes("TODO-resolve")) {
        warnings.push(`${label}: route contains an unresolved TODO-resolve placeholder: ${entry.route}`);
      }
    }

    if (entry.kind === "terminal" && !entry.command) {
      errors.push(`${label}: terminal entries require a command`);
    }
  }

  return { errors, warnings };
}

function printList(entries) {
  for (const entry of entries) {
    const tier = entry.tier ? ` tier=${entry.tier}` : "";
    console.log(`${entry.id}\t${entry.kind}${tier}\t${entry.output}`);
  }
}

// Absolute path to the reservation MCP fixture (docs/scripts/screenshots/
// fixtures/reservation-server.mjs), used by `connect-widget-fixture` below.
// Forward slashes: the value is typed into a plain text input the app later
// hands to `child_process.spawn` on Windows, which accepts either separator.
const RESERVATION_FIXTURE_PATH = path
  .join(__dirname, "fixtures", "reservation-server.mjs")
  .split(path.sep)
  .join("/");

const DEMO_SERVER_NAME = "demo-everything";
const DEMO_SERVER_COMMAND = "npx -y @modelcontextprotocol/server-everything";
const WIDGET_FIXTURE_SERVER_NAME = "reservation-widget";
const WIDGET_FIXTURE_COMMAND = `node ${RESERVATION_FIXTURE_PATH} --stdio`;

const ADD_SERVER_COMMAND_PLACEHOLDER =
  "npx -y @modelcontextprotocol/server-everything";
const ADD_SERVER_NAME_PLACEHOLDER = "my-mcp-server";

// getting-started-first-diagram (route /playground): the real Excalidraw
// sample server -- a genuine remote HTTP MCP server (mcp.excalidraw.com),
// not something with a local STDIO equivalent to substitute in like
// connect-widget-fixture does. name/url match lib/excalidraw-quick-connect.ts's
// EXCALIDRAW_SERVER_CONFIG (the same config the app's own first-run
// onboarding auto-connects), so the connected server row looks exactly like
// what a real user gets on first launch.
const EXCALIDRAW_SERVER_NAME = "Excalidraw (App)";
const EXCALIDRAW_SERVER_URL = "https://mcp.excalidraw.com/mcp";
const EXCALIDRAW_PROMPT = "Draw me an MCP architecture diagram";
const RESERVATION_PROMPT = "I'd like to make a reservation at Jammy Wammy.";

// Fills and submits the "Import Servers from JSON" modal -- ServersTab.tsx's
// alternate entry point next to "Add manually" in the Add Server hover
// card (handleImportJsonClick / JsonImportModal.tsx). Used only for the
// Excalidraw sample server: it's a genuine remote HTTP server with no local
// STDIO fallback, and the regular "Add Server" HTTP form is blocked by the
// same shared-backend Convex schema bug documented on connect-widget-fixture
// below (`servers:createServerIfMissing`/`updateServer` reject the client's
// `authMethod` field) -- confirmed by testing the HTTP form against this
// dev backend directly. The JSON import path sidesteps it because
// parseJsonConfig (lib/json-config-parser.ts) builds HTTP ServerFormData
// with no `authMethod` field at all, unlike the regular form which always
// sets one. The editor is CodeMirror-based (JsonEditor's default
// editSurface="codemirror" -- see components/ui/json-editor/json-editor.tsx),
// not a plain <textarea>, so it's driven by clicking the `.cm-content`
// editable region and typing rather than `.fill()`.
async function importHttpServerViaJson(page, { name, url }) {
  await page.getByRole("button", { name: "Add Server" }).hover();
  await page.getByRole("button", { name: "Import JSON" }).click();
  const dialog = page.getByRole("dialog");
  const configJson = JSON.stringify({
    mcpServers: { [name]: { type: "sse", url } },
  });
  await dialog.locator(".cm-content").first().click();
  await page.keyboard.type(configJson);
  await dialog.getByRole("button", { name: "Import Servers" }).click();
}

// Types into and submits the Playground's chat composer. The textarea has
// no stable placeholder across empty-state variants (it reads "Try a
// prompt that could call your tools..." here, different text elsewhere), so
// it's targeted by CSS instead -- scoped to `:visible` because the page
// also has a hidden "Ask anything…" textarea (the global "Ask MCPJam"
// widget) that otherwise sorts first in DOM order.
async function sendPlaygroundMessage(page, text) {
  const composer = page.locator("textarea:visible").first();
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

// Resets the Playground chat if it already has messages before this step's
// own prompt is sent. This dev environment's guest identity is effectively
// shared across "fresh" browser contexts (ALLOW_LOCAL_DEV_SERVICE_TOKEN=true
// on the local backend, plus the JSON-RPC replay stream reconnecting
// clients to server-held state) -- a new Playwright context here is not a
// reliable guarantee of a new chat thread the way it is for e.g. onboarding
// localStorage flags. The clear-chat control (a trash-icon button, tooltip
// "Clear chat") only renders once the thread has messages
// (`effectiveHasMessages` in PlaygroundMain.tsx), so its absence already
// means there is nothing to clear.
async function clearPlaygroundChatIfPresent(page) {
  // Scoped to `[data-slot="tooltip-trigger"]` (the Radix Tooltip wrapper
  // PlaygroundMain.tsx renders this button through) -- a plain
  // `svg.lucide-trash-2` match is not unique on this page: logger-view.tsx's
  // unrelated "Clear all messages" debug-log button uses the same icon and
  // is present in the DOM regardless of route.
  const clearButton = page
    .locator('button[data-slot="tooltip-trigger"]:has(svg.lucide-trash-2)')
    .first();
  const hasExistingChat = await clearButton.isVisible().catch(() => false);
  if (!hasExistingChat) return;
  await clearButton.click();
  await page.getByRole("button", { name: "Reset chat" }).click();
  await clearButton.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
}

// Waits for a tool-call card by tool name -- same collapsible-header
// locator pattern as open-widget-debug's cardHeader below -- then for the
// widget iframe it renders, then for the assistant's turn to finish
// streaming (the "Stop generating" button reverts to "Send message") so the
// capture doesn't land mid-stream on a half-drawn diagram or a pending
// spinner. Returns the card header locator so callers can scroll it into
// view before the final settle.
async function waitForToolWidget(page, toolName, timeoutMs = 90000) {
  const cardHeader = page
    .locator('[role="button"][aria-expanded]')
    .filter({ hasText: toolName })
    .first();
  await cardHeader.waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator("iframe").first().waitFor({ state: "visible", timeout: timeoutMs });
  await page
    .getByRole("button", { name: "Stop generating" })
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .catch(() => {
      // Already finished (or never showed a Stop button) by the time we
      // checked -- not fatal, the iframe wait above already gates on real
      // progress.
    });
  return cardHeader;
}

// Fills and submits the Add Server modal for a STDIO server. Assumes the
// modal is not yet open. STDIO (not HTTP) is used for every tier-A setup
// step that needs a connected server -- see the `connect-widget-fixture`
// comment below for why HTTP add-server is not an option in this dev
// environment right now.
async function addStdioServer(page, { name, command }) {
  await page.getByRole("button", { name: "Add Server" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder(ADD_SERVER_NAME_PLACEHOLDER).fill(name);
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "STDIO" }).click();
  await dialog
    .getByPlaceholder(ADD_SERVER_COMMAND_PLACEHOLDER)
    .fill(command);
  await dialog.getByRole("button", { name: "Add Server" }).click();
}

// Connected/failed status renders as visible text on the server card
// ("Connected" / "Failed (n)"). Waiting for the literal "Connected" text is
// the simplest reliable signal available without a dedicated test id.
async function waitForServerConnected(page, timeoutMs = 60000) {
  await page
    .getByText("Connected", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

// In-app sidebar navigation (client-side route change) -- NOT page.goto.
// Every setup step that needs to visit /servers mid-flow must get there this
// way and back: a full page.goto/reload tears down the live STDIO child
// process the app just spawned, so a hard navigation here would silently
// undo the connection this same step is trying to establish.
//
// The sidebar's nav items are plain <button>s (mcp-sidebar.tsx), not <a>
// links, and this one's accessible name is "ModelContextProtocol Connect"
// (its icon contributes alt text ahead of the visible "Connect" label) --
// matched here with a suffix regex rather than an exact string.
async function goToServersInApp(page) {
  if (/\/servers(?:$|[/?#])/.test(new URL(page.url()).pathname)) return;
  await page.getByRole("button", { name: /Connect$/ }).first().click();
  await page.waitForURL(/\/servers/);
}

// Named setup steps a manifest "ui" entry can reference by name. Referencing
// an unregistered name is a per-entry failure, not a crash -- see
// runSetupSteps below.
const SETUP_STEPS = {
  // compat-strip (route /servers): connect the demo server and let the
  // host-compat strip render on its own card -- no further action needed.
  "connect-demo-server": async (page) => {
    await goToServersInApp(page);
    await addStdioServer(page, {
      name: DEMO_SERVER_NAME,
      command: DEMO_SERVER_COMMAND,
    });
    await waitForServerConnected(page);
  },

  // widget-debug-panel (route /playground): connect the reservation fixture
  // over STDIO, not HTTP as originally planned. In this dev environment the
  // web app's HTTP "Add Server" flow is blocked before it ever reaches the
  // MCP server: the shared dev Convex backend's `servers:createServerIfMissing`
  // / `updateServer` mutations reject the client's `authMethod` field
  // ("ArgumentValidationError: Object contains extra field `authMethod`"),
  // which is a pre-existing schema mismatch on that shared backend, not
  // something this docs-only change can fix. STDIO add-server does not hit
  // that code path and works normally, and the reservation fixture's
  // MCP server + widget behave identically regardless of transport (see
  // fixtures/reservation-server.mjs's `--stdio` branch), so this is a safe
  // substitution for the capture's purposes.
  "connect-widget-fixture": async (page) => {
    await goToServersInApp(page);
    await addStdioServer(page, {
      name: WIDGET_FIXTURE_SERVER_NAME,
      command: WIDGET_FIXTURE_COMMAND,
    });
    await waitForServerConnected(page);
  },

  // oauth-configure-modal (route /oauth-flow): fresh guest state has no OAuth
  // target configured yet, so the "Configure Server to Test" modal opens
  // automatically on mount (client/src/components/OAuthFlowTab.tsx opens it
  // whenever `!hasProfile`) -- no click needed, just wait for it. Only click
  // the configure trigger as a fallback for a session that already has a
  // profile (dialog not auto-shown).
  "open-configure-modal": async (page) => {
    const heading = page.getByRole("heading", { name: "Configure Server to Test" });
    // The modal auto-opens shortly after mount when there's no OAuth profile
    // yet, but not instantly -- give it a moment before falling back to a
    // manual click, so the click doesn't race the auto-open and end up
    // targeting a "Configure Target" button the auto-opened dialog is
    // already covering.
    const autoOpened = await heading
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!autoOpened) {
      await page.getByRole("button", { name: /Configure/i }).first().click();
      await heading.waitFor({ state: "visible", timeout: 10000 });
    }
  },

  // compatibility-report (route /compatibility): connect the demo server
  // from /servers, then return via browser history (not page.goto -- same
  // reason as goToServersInApp) so the live connection survives, and
  // trigger the on-demand conformance run.
  "run-compat": async (page) => {
    await goToServersInApp(page);
    await addStdioServer(page, {
      name: DEMO_SERVER_NAME,
      command: DEMO_SERVER_COMMAND,
    });
    await waitForServerConnected(page);
    await page.goBack();
    await page.waitForURL(/\/compatibility/);
    await page.getByRole("button", { name: /Run checks/i }).click();
    await page
      .getByText(/Checking…/)
      .first()
      .waitFor({ state: "hidden", timeout: 30000 })
      .catch(() => {
        // Fine if it never renders "Checking…" at all (fast enough to skip
        // straight to a result) -- the generic no-spinner check after setup
        // steps still guards against a truly stuck run.
      });
  },

  // widget-debug-panel (route /playground): invoke the reservation fixture's
  // one UI tool manually from the Tools panel, then open the debug tabs on
  // the resulting tool-call card.
  "open-widget-debug": async (page) => {
    await goToServersInApp(page);
    await addStdioServer(page, {
      name: WIDGET_FIXTURE_SERVER_NAME,
      command: WIDGET_FIXTURE_COMMAND,
    });
    await waitForServerConnected(page);

    await page.getByRole("button", { name: "Playground", exact: true }).click();
    await page.waitForURL(/\/playground/);

    await page.getByText("get-reservation", { exact: true }).click();
    await page.getByRole("button", { name: "Run" }).click();

    // The rendered tool-call card's "Data" control both expands the card and
    // sets the active debug tab to Data in one click (tool-part.tsx's
    // handleDebugClick: aria-label "Data" -> setUserExpanded(true) +
    // setActiveDebugTab("data")) -- no separate "expand" click needed.
    // The card's "Data" debug tab is already the pre-selected tab by
    // default (tool-part.tsx's activeDebugTab starts at "data"), but the
    // content pane under it only renders once the card itself is expanded
    // (a separate `userExpanded` state, starts false). Click the card's own
    // collapsible header -- a role="button" row whose accessible name is
    // "get-reservation" followed by every child control's label -- to
    // expand it via toggleExpanded(). Clicking the "Data" button instead
    // would toggle activeDebugTab from "data" to null (handleDebugClick's
    // already-active branch), collapsing the card instead of opening it.
    const cardHeader = page
      .locator('[role="button"][aria-expanded]')
      .filter({ hasText: "get-reservation" })
      .first();
    await cardHeader.waitFor({ state: "visible", timeout: 15000 });
    await cardHeader.click();
    await page.locator('[role="button"][aria-expanded="true"]').filter({ hasText: "get-reservation" }).first()
      .waitFor({ state: "visible", timeout: 5000 });
  },

  // getting-started-first-diagram (route /playground): connect the real
  // Excalidraw sample server (see importHttpServerViaJson above for why
  // JSON import instead of the regular Add Server form), then send the
  // getting-started.mdx sample prompt and wait for the `create_view` tool
  // call and its rendered diagram. LLM latency plus the diagram drawing
  // element-by-element (per the tool's own description) means this needs
  // the generous timeouts baked into waitForToolWidget.
  "send-excalidraw-prompt": async (page) => {
    await goToServersInApp(page);
    await importHttpServerViaJson(page, {
      name: EXCALIDRAW_SERVER_NAME,
      url: EXCALIDRAW_SERVER_URL,
    });
    await waitForServerConnected(page);

    await page.getByRole("button", { name: "Playground", exact: true }).click();
    await page.waitForURL(/\/playground/);

    await clearPlaygroundChatIfPresent(page);
    await sendPlaygroundMessage(page, EXCALIDRAW_PROMPT);
    const cardHeader = await waitForToolWidget(page, "create_view", 90000);
    await cardHeader.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
  },

  // first-mcp-app-playground (route /playground): connect the reservation
  // fixture (same STDIO substitution as connect-widget-fixture/
  // open-widget-debug above) and prompt the model to book a table so
  // `get-reservation` runs and its "Reservation Confirmed" widget renders.
  "invoke-reservation-tool": async (page) => {
    await goToServersInApp(page);
    await addStdioServer(page, {
      name: WIDGET_FIXTURE_SERVER_NAME,
      command: WIDGET_FIXTURE_COMMAND,
    });
    await waitForServerConnected(page);

    await page.getByRole("button", { name: "Playground", exact: true }).click();
    await page.waitForURL(/\/playground/);

    await clearPlaygroundChatIfPresent(page);
    await sendPlaygroundMessage(page, RESERVATION_PROMPT);
    await waitForToolWidget(page, "get-reservation", 90000);
    await page.waitForTimeout(1500);
  },

  // client-focus-panel (route /hosts?template=claude): the template deep
  // link (client/src/App.tsx's useTemplateVerifyDeepLink) creates the host
  // and redirects from /hosts?template=claude to /hosts/:hostId itself on
  // mount -- no click needed -- but that redirect is async (a Convex
  // mutation), so wait for it and for the focus panel's settings to render
  // before the generic post-setup checks run.
  "wait-host-template-panel": async (page) => {
    await page.waitForURL(/\/hosts\//, { timeout: 20000 });
    await page
      .getByText("Agent tooling", { exact: true })
      .waitFor({ state: "visible", timeout: 20000 });
  },

  // host-compare-view (route /host-compare): a fresh visit with no stored
  // selection defaults to comparing the ChatGPT and Claude presets
  // (DEFAULT_COMPARE_HOST_IDS in host-compare-selection.ts) -- no host setup
  // required. Just wait for both preset columns to render.
  "wait-host-compare-columns": async (page) => {
    await page
      .getByText("ChatGPT", { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    await page
      .getByText("Claude", { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
  },

  // --- Tier C (hosted logged-in session) ----------------------------------
  // The three steps below only make sense against the hosted app with a real
  // STORAGE_STATE session (see `--login` and STORAGE_STATE above) -- there is
  // no local guest equivalent to test them against. Their selectors are
  // therefore derived by reading the client source rather than by driving a
  // live session, unlike every step above. Expect the capture runner to need
  // small adjustments here the first time these actually run against the
  // hosted app, if the live DOM has drifted from what's read below.

  // project-switcher (route /home): click the sidebar's org/project switcher
  // trigger -- SidebarContextSwitcher's SidebarMenuButton in
  // client/src/components/sidebar/sidebar-context-switcher.tsx, whose
  // accessible name is "Switch context: <org> / <project>" once an
  // organization is resolved, or "Switch project: <project>" before one is
  // -- then wait for the dropdown (Radix DropdownMenu.Content, which renders
  // role="menu") to open over the sidebar.
  "open-project-switcher": async (page) => {
    await page
      .getByRole("button", { name: /^Switch (context|project):/ })
      .click();
    await page.getByRole("menu").waitFor({ state: "visible", timeout: 10000 });
  },

  // evals-run-detail (route /evals): click the first suite row -- each row is
  // `[data-testid="suite-row-<id>"]` with a "Select suite: <name>" button,
  // see SuiteOverviewRow in client/src/components/evals/evals-suite-list-sidebar.tsx
  // -- which client-side-navigates to /evals/suite/:suiteId (router.tsx).
  // Then click the first run row in that suite: SuiteRunsList
  // (client/src/components/evals/suite-runs-list.tsx) sorts its rows
  // newest-first, so the first "Open run <id>" button is always the most
  // recent run, which navigates to /evals/suite/:suiteId/runs/:runId. Both
  // final waits are best-effort: ToolCallsDiffView
  // (client/src/components/evals/tool-calls-diff-view.tsx) shows a
  // "Comparing tool calls…" banner only while grading is still in flight,
  // and its "Expected"/"Actual" side-by-side labels only render once a
  // name-mismatch row is expanded -- neither is guaranteed for every run
  // (a clean pass may have nothing worth expanding).
  "open-run-detail": async (page) => {
    const suiteRow = page.locator('[data-testid^="suite-row-"]').first();
    await suiteRow.waitFor({ state: "visible", timeout: 20000 });
    await suiteRow.getByRole("button", { name: /^Select suite:/ }).click();
    await page.waitForURL(/\/evals\/suite\//, { timeout: 20000 });

    const runButton = page.getByRole("button", { name: /^Open run / }).first();
    await runButton.waitFor({ state: "visible", timeout: 20000 });
    await runButton.click();
    await page.waitForURL(/\/evals\/suite\/[^/]+\/runs\//, { timeout: 20000 });

    await page
      .getByText("Comparing tool calls…")
      .first()
      .waitFor({ state: "hidden", timeout: 15000 })
      .catch(() => {});
    await page
      .getByText("Expected", { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
  },

  // hosted-reveal-tokens (route /servers): open the first connected server's
  // detail modal by clicking its card -- ServerConnectionCard
  // (client/src/components/connection/ServerConnectionCard.tsx) renders each
  // server as a design-system `Card` (`[data-slot="card"]`, see
  // design-system/src/components/card.tsx), scoped here to one that shows
  // the "Connected" status label (server-card-utils.ts's
  // getConnectionStatusMeta) to skip past any quick-connect catalog cards on
  // the same page. The card click opens ServerDetailModal
  // (client/src/components/connection/ServerDetailModal.tsx) on its
  // "Configuration" tab by default, so switch to the "Overview" tab
  // (a Radix Tabs.Trigger, role="tab") and scroll the "OAuth Tokens" section
  // (ServerInfoContent.tsx) into view. Deliberately never clicks that
  // section's "Reveal tokens" button -- captures must keep OAuth tokens
  // masked.
  "open-reveal-tokens": async (page) => {
    const serverCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Connected" })
      .first();
    await serverCard.waitFor({ state: "visible", timeout: 20000 });
    await serverCard.click();

    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 20000 });
    await dialog.getByRole("tab", { name: "Overview" }).click();

    const oauthHeading = dialog.getByText("OAuth Tokens", { exact: true });
    await oauthHeading.waitFor({ state: "visible", timeout: 20000 });
    await oauthHeading.scrollIntoViewIfNeeded();
  },
};

const APP_SHELL_TIMEOUT_MS = 30000;
// The app keeps a long-lived SSE connection open (`/api/mcp/subscribe`) for
// live updates, so a strict `networkidle` never actually fires -- Playwright
// counts that open connection as in-flight forever. Treat it as a best-effort
// settle with a short bound instead of the default 30s: fall through to the
// spinner check either way, since that is the more meaningful signal that the
// page has actually finished rendering.
const NETWORK_IDLE_TIMEOUT_MS = 5000;

async function runSetupSteps(entry, page) {
  for (const step of entry.setup ?? []) {
    const run = SETUP_STEPS[step];
    if (!run) {
      throw new Error(`unknown setup step "${step}" (no entry registered in SETUP_STEPS)`);
    }
    await run(page);
  }
}

// Fails loudly if any `.animate-spin` element is still visible once the page
// has otherwise settled -- a frozen spinner in a capture means the state we
// meant to show hasn't actually loaded yet.
async function assertNoVisibleSpinners(page) {
  const spinners = page.locator(".animate-spin");
  const count = await spinners.count();
  for (let i = 0; i < count; i++) {
    if (await spinners.nth(i).isVisible()) {
      throw new Error("a .animate-spin element is still visible after settling");
    }
  }
}

async function captureUi(entry, { browser }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "en-US",
    ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
  });

  // Force light theme before any app script runs, regardless of the OS/browser
  // color-scheme preference. Also mark the first-run NUX as already completed:
  // a fresh guest context otherwise gets redirected away from /servers (and
  // /home, /clients, /hosts) to /playground until onboarding has been "seen"
  // (see client/src/lib/onboarding-state.ts), which would silently capture the
  // wrong screen for every entry that doesn't specifically want that redirect.
  await context.addInitScript(() => {
    localStorage.setItem("themeMode", "light");
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed" }),
    );
  });

  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}${entry.route}`);
    await page.getByTestId("app-shell").waitFor({ state: "visible", timeout: APP_SHELL_TIMEOUT_MS });

    await runSetupSteps(entry, page);

    try {
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS });
    } catch {
      // See NETWORK_IDLE_TIMEOUT_MS above -- expected, not fatal.
    }
    await assertNoVisibleSpinners(page);

    const finalPath = path.join(REPO_ROOT, entry.output);
    await mkdir(path.dirname(finalPath), { recursive: true });

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-screenshot-"));
    const tmpPath = path.join(tmpDir, "capture.png");

    // Viewport screenshot only (not fullPage): captures must match the fixed
    // 1440x900 frame every time, not whatever the page's scroll height is.
    await page.screenshot({ path: tmpPath });
    await rename(tmpPath, finalPath);
  } finally {
    await context.close();
  }
}

// Strip the only ANSI the CLI ever emits: `\r\x1b[K` progress heartbeats and
// `\x1b[...m` color codes (dim/reset). There is no full terminal emulation
// here on purpose -- the CLI has no other stray control sequences.
function stripAnsi(text) {
  return text.replace(/\r\x1b\[K/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateLines(text, maxLines) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function combineOutput(stdout, stderr) {
  const parts = [];
  if (stdout && stdout.trim().length > 0) parts.push(stdout.replace(/\s+$/, ""));
  if (stderr && stderr.trim().length > 0) parts.push(stderr.replace(/\s+$/, ""));
  return parts.join("\n");
}

// Runs the built CLI out-of-process and returns combined stdout+stderr text.
// A non-zero exit code is a normal, renderable result for several of these
// commands (e.g. a failing conformance check), so we only treat it as fatal
// when execFile couldn't capture any output at all (spawn failure).
async function runCliCapture(entry) {
  const execArgs = [...entry.args];
  if (FORMAT_HUMAN_IDS.has(entry.id)) {
    execArgs.push("--format", "human");
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, ...execArgs],
      {
        timeout: entry.timeoutMs ?? 30000,
        env: { ...process.env, NO_COLOR: "1" },
        cwd: REPO_ROOT,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return combineOutput(stdout, stderr);
  } catch (err) {
    if (typeof err.stdout === "string" || typeof err.stderr === "string") {
      return combineOutput(err.stdout ?? "", err.stderr ?? "");
    }
    throw err;
  }
}

// `mcpjam mcp` runs forever serving JSON-RPC over stdio, so it needs a
// special capture path: spawn it, wait for the one-line stderr readiness
// banner, kill it, and render just that line.
async function runMcpStdioCapture(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...entry.args], {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
    });

    let settled = false;
    let stderrBuf = "";

    const timeoutMs = entry.timeoutMs ?? 3000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out waiting for the stdio ready line after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.includes(MCP_STDIO_READY_LINE)) {
        finish(null, MCP_STDIO_READY_LINE);
      }
    });

    child.on("error", (err) => finish(err));
    child.on("exit", () => finish(new Error("process exited before the stdio ready line appeared")));
  });
}

async function captureTerminal(entry, { browser }) {
  const rawOutput =
    entry.id === "cli-mcp-stdio"
      ? await runMcpStdioCapture(entry)
      : await runCliCapture(entry);

  const cleaned = stripAnsi(rawOutput).replace(/\s+$/, "");
  const truncated = truncateLines(cleaned, MAX_OUTPUT_LINES);
  const escapedOutput = escapeHtml(truncated);
  const displayCommand = escapeHtml([entry.command, ...entry.args].join(" "));

  const template = readFileSync(TERMINAL_TEMPLATE_PATH, "utf8");
  const html = template
    .replaceAll("<!-- COMMAND -->", displayCommand)
    .replaceAll("<!-- OUTPUT -->", escapedOutput);

  const page = await browser.newPage({
    viewport: { width: 960, height: 700 },
    deviceScaleFactor: 2,
  });

  try {
    await page.setContent(html, { waitUntil: "load" });

    const finalPath = path.join(REPO_ROOT, entry.output);
    await mkdir(path.dirname(finalPath), { recursive: true });

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-screenshot-"));
    const tmpPath = path.join(tmpDir, "capture.png");

    await page.locator(".window").screenshot({ path: tmpPath });
    await rename(tmpPath, finalPath);
  } finally {
    await page.close();
  }
}

// `--login` mode: opens a real, headed browser against the hosted app so a
// human can log in, then saves the resulting session as a Playwright storage
// state for later tier C runs (`STORAGE_STATE=.screenshot-auth/state.json
// node docs/scripts/screenshots/capture.mjs --tier C` -- see README.md).
// This is the one step in the whole harness that needs a person present.
async function runLogin() {
  console.log(`Opening a browser window at ${LOGIN_BASE_URL}`);
  console.log(
    "Log in in the opened window, then press Enter here to save the session.",
  );

  // headless: false (not the default headless launch the rest of this file
  // uses) -- there is no way to complete a real login flow (SSO redirects,
  // 2FA, etc.) without a visible window for the human to interact with.
  const browser = await chromium.launch({ channel: "chromium", headless: false });

  // Tracks whether the user closed the browser window themselves instead of
  // pressing Enter -- that's a clean, expected way to abort, not a crash.
  let browserClosedByUser = false;
  const disconnected = new Promise((resolve) => {
    browser.once("disconnected", () => {
      browserClosedByUser = true;
      resolve();
    });
  });

  const context = await browser.newContext();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const page = await context.newPage();
    await page.goto(LOGIN_BASE_URL);

    // Whichever happens first: the user presses Enter in this terminal, or
    // they close the browser window (disconnected fires) instead.
    await Promise.race([
      rl.question("Press Enter once you're logged in: "),
      disconnected,
    ]);

    if (browserClosedByUser) {
      throw new Error(
        "the browser window was closed before login was confirmed -- no session was saved. Re-run --login and keep the window open until you press Enter.",
      );
    }

    await mkdir(STORAGE_STATE_DIR, { recursive: true });
    await context.storageState({ path: STORAGE_STATE_OUTPUT_PATH });
    console.log(`Saved session to ${STORAGE_STATE_OUTPUT_PATH}`);
    console.log(
      "This file is gitignored (.screenshot-auth/) -- never commit it, it is a live session credential.",
    );
  } finally {
    rl.close();
    if (!browserClosedByUser) {
      await browser.close();
    }
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (opts.login) {
    try {
      await runLogin();
    } catch (err) {
      console.error(`Login failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const manifest = loadManifest();
  const selected = filterEntries(manifest.entries, opts);

  if (opts.list) {
    printList(selected);
    return;
  }

  if (opts.validate) {
    const { errors, warnings } = validateManifest(manifest);
    for (const warning of warnings) {
      console.warn(`WARN: ${warning}`);
    }
    if (errors.length > 0) {
      console.error(`manifest INVALID (${errors.length} error(s)):`);
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`manifest OK (${manifest.entries.length} entries)`);
    return;
  }

  if (selected.length === 0) {
    console.error("No manifest entries matched the given filters.");
    process.exitCode = 1;
    return;
  }

  console.log(`Base URL: ${BASE_URL}`);
  if (STORAGE_STATE) {
    console.log(`Storage state: ${STORAGE_STATE}`);
  }

  // Only pay for a browser launch when a selected entry actually needs one;
  // --validate/--list return before this point, and there's no other kind yet.
  const needsBrowser = selected.some((entry) => entry.kind === "ui" || entry.kind === "terminal");
  // Pin the regular chromium build (not the separate chrome-headless-shell
  // package Playwright otherwise auto-selects for headless launches) so the
  // only setup step is `npx playwright install chromium`.
  const browser = needsBrowser ? await chromium.launch({ channel: "chromium" }) : null;

  let ok = 0;
  let failed = 0;

  try {
    for (const entry of selected) {
      try {
        if (entry.kind === "ui") {
          await captureUi(entry, { browser });
        } else if (entry.kind === "terminal") {
          await captureTerminal(entry, { browser });
        } else {
          throw new Error(`unknown kind: ${entry.kind}`);
        }
        console.log(`ok    ${entry.id}`);
        ok++;
      } catch (err) {
        console.error(`fail  ${entry.id}: ${err.message}`);
        failed++;
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  console.log(`${ok} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
