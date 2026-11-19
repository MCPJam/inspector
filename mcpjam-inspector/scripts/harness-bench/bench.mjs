#!/usr/bin/env node
/**
 * Hosted harness first-text benchmark for the Playground (HARN-130).
 *
 * Drives one or two signed-in Inspector instances (each from `qa:start`) in a
 * real browser, alternating them in matched pairs and reversing the order
 * every pair. Each instance's sequence per pair: a fresh chat with "Reply
 * exactly Ready", an immediate follow-up in the same chat, and optionally a
 * fresh chat with three verified echo calls. The primary clock is the Send
 * keydown to the first assistant text painted; the instance's log supplies
 * the server's `[harness][timing]` and `[harness][trace]` lines for the turn.
 *
 *   node scripts/harness-bench/bench.mjs \
 *     --instance A,http://localhost:5173,<storage-state.json>,<inspector.log>[,<label>] \
 *     --instance B,http://localhost:5174,<storage-state.json>,<inspector.log>[,<label>] \
 *     --project <projectId> --client "Claude Code" --pairs 5 \
 *     --workloads first,followup,echo3 --primers 1 --out <results.jsonl>
 *
 * Every measured turn is kept, failures included. Summaries: report.mjs.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { logSize, parseHarnessLog, readLogSince } from "./server-log.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("playwright");

function parseArgs(argv) {
  const args = { instances: [], pairs: 5, primers: 1, workloads: ["first", "followup"], turnTimeoutMs: 180_000, sendDelayMs: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--instance": {
        const [name, client, storage, log, label] = value.split(",");
        args.instances.push({ name, client, storage, log, label: label ?? name });
        i += 1;
        break;
      }
      case "--project": args.project = value; i += 1; break;
      case "--client": args.client = value; i += 1; break;
      case "--model": args.model = value; i += 1; break;
      case "--pairs": args.pairs = Number(value); i += 1; break;
      case "--primers": args.primers = Number(value); i += 1; break;
      case "--workloads": args.workloads = value.split(","); i += 1; break;
      case "--out": args.out = value; i += 1; break;
      case "--run": args.run = value; i += 1; break;
      case "--turn-timeout": args.turnTimeoutMs = Number(value) * 1000; i += 1; break;
      case "--send-delay": args.sendDelayMs = Number(value); i += 1; break;
      case "--headed": args.headed = true; break;
      default: throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (!args.instances.length || !args.project || !args.client || !args.out) {
    throw new Error("Pass --instance (1 or 2), --project, --client and --out.");
  }
  args.run ??= new Date().toISOString().replace(/[:.]/g, "-");
  return args;
}

const PROBE = readFileSync(new URL("./page-probe.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Best-effort UI steps: a miss is reported, not fatal, and the turn's own
// checks decide the outcome.
const bestEffort = (step) => (error) => {
  if (process.env.BENCH_DEBUG) console.error(`[bench] ${step} skipped: ${error.message.split("\n")[0]}`);
};

const PROMPTS = {
  first: () => ({ prompt: "Reply exactly Ready. Do not use tools.", expect: /ready/i }),
  followup: () => ({ prompt: "Reply exactly Done. Do not use tools.", expect: /done/i }),
  echo3: () => {
    const tag = randomUUID().slice(0, 8);
    const markers = ["alpha", "beta", "gamma"].map((word) => `${word}-${tag}`);
    return {
      prompt: `Use the echo tool three times, one call at a time, with the messages ${markers.join(", ")}. Then reply with only the three echoed values.`,
      expect: null,
      markers,
    };
  },
};

async function openInstance(browser, instance, args, opened) {
  const context = await browser.newContext({ storageState: instance.storage, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  // Registered before anything can fail: the app rotates the session on load,
  // so this context's storage state must be saved back whatever happens.
  const entry = { ...instance, context, page, logOffset: logSize(instance.log) };
  opened.push(entry);
  await context.addInitScript(PROBE);
  await page.goto(`${instance.client}/p/${args.project}/playground`, { waitUntil: "domcontentloaded" });
  await page.locator('textarea[placeholder^="Try a prompt"]').first().waitFor({ timeout: 60_000 });
  await sleep(3_000);
  await selectClient(page, args.client);
  if (args.model) await selectModel(page, args.model);
  return entry;
}

async function composerChip(page, prefix) {
  const chip = page.locator(`button[aria-label^="${prefix}"]`).first();
  return (await chip.count()) ? chip.getAttribute("aria-label") : null;
}

async function selectClient(page, client) {
  const current = await composerChip(page, "Client: ");
  if (current === `Client: ${client}`) return;
  if (current === null) {
    // Compare mode: the picker's "Use only" leaves it for one client.
    await page.locator("textarea").first().locator("xpath=ancestor::form[1]").locator("button").filter({ hasText: /\S/ }).last().click();
    await page.getByRole("button", { name: `Use only ${client}` }).first().click();
    await sleep(1_500);
    if ((await composerChip(page, "Client: ")) === `Client: ${client}`) return;
  }
  // The project's own clients load after the built-in ones: reopen until listed.
  for (let attempt = 0; ; attempt += 1) {
    await page.locator('button[aria-label^="Client: "]').first().click();
    const exact = new RegExp(`^\\s*${client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    const option = page.locator('[role="option"]').filter({ hasText: exact });
    try {
      await option.first().waitFor({ timeout: 10_000 });
      await option.first().click();
      break;
    } catch (error) {
      await page.keyboard.press("Escape");
      if (attempt >= 3) throw error;
      await sleep(3_000);
    }
  }
  await sleep(1_500);
  const now = await composerChip(page, "Client: ");
  if (now !== `Client: ${client}`) throw new Error(`Could not select client ${client} (chip says ${now})`);
}

async function selectModel(page, model) {
  // The model chip sits after the client chip in the composer.
  const chips = page.locator('button[aria-label^="Client: "] ~ button');
  await chips.first().click();
  await page.getByRole("option", { name: model }).first().click();
  await sleep(1_000);
}

async function composerState(page) {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll("button[aria-label], button")]
      .map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim())
      .filter(Boolean);
    return {
      client: labels.find((l) => l.startsWith("Client: ")) ?? null,
      effort: labels.find((l) => l.startsWith("Reasoning effort")) ?? null,
      messages: document.querySelectorAll("[data-message-id]").length,
    };
  });
}

// A new chat (a new chat session id, so a new box) for every first message.
// A failed turn can leave an empty transcript on the old session, so an empty
// transcript is not proof of a new chat: the chat is cleared or reset whenever
// the app offers it, and reloaded when it offers neither.
async function freshChat(instance, args) {
  const { page } = instance;
  const clear = page.getByRole("button", { name: "Clear chat" }).first();
  const reset = page.getByRole("button", { name: "Reset chat" }).first();
  if (await clear.isVisible().catch(() => false)) {
    await clear.click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    if (await dialog.first().isVisible().catch(() => false)) {
      const remember = dialog.getByText("Don't show this again");
      if (await remember.count()) await remember.first().click().catch(bestEffort("remember the clear-chat choice"));
      await dialog.getByRole("button", { name: "Clear chat" }).first().click();
    }
  } else if (await reset.isVisible().catch(() => false)) {
    await reset.click();
  } else if (instance.lastChatSessionId) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('textarea[placeholder^="Try a prompt"]').first().waitFor({ timeout: 60_000 });
    await sleep(3_000);
    await selectClient(page, args.client);
  }
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length === 0, null, { timeout: 15_000 });
  await sleep(500);
}

function between(a, b) {
  return a == null || b == null ? null : Math.round(b - a);
}

async function runTurn(instance, workload, meta, args) {
  const { page } = instance;
  const spec = PROMPTS[workload]();
  const composer = page.locator('textarea[placeholder^="Try a prompt"]').first();
  await composer.waitFor({ timeout: 30_000 });
  const before = readLogSince(instance.log, instance.logOffset);
  instance.logOffset = before.offset;
  const wallStart = Date.now();
  const index = await page.evaluate((prompt) => window.__harnessBench.arm(prompt), spec.prompt);
  await composer.fill(spec.prompt);
  if (args.sendDelayMs) await sleep(args.sendDelayMs);
  await composer.press("Enter");
  let failure = null;
  let approvals = 0;
  const deadline = Date.now() + args.turnTimeoutMs;
  let probe = null;
  let settledSince = null;
  for (;;) {
    probe = await page.evaluate((i) => window.__harnessBench.read(i), index);
    const request = probe.requests[probe.requests.length - 1];
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    if (await approve.first().isVisible().catch(() => false)) {
      if (!spec.markers) {
        failure = "approval_requested";
        await page.getByRole("button", { name: "Deny", exact: true }).first().click().catch(bestEffort("deny an unexpected approval"));
        break;
      }
      await approve.first().click().catch(bestEffort("approve the echo call"));
      approvals += 1;
      settledSince = null;
      await sleep(500);
      continue;
    }
    const stopVisible = await page.locator('button[aria-label="Stop generating"]').first().isVisible().catch(() => false);
    const settled = request && request.end !== null && !stopVisible;
    if (settled) {
      settledSince ??= Date.now();
      if (Date.now() - settledSince > 1_500) break;
    } else {
      settledSince = null;
    }
    if (Date.now() > deadline) {
      failure = "timeout";
      await page.locator('button[aria-label="Stop generating"]').first().click().catch(bestEffort("stop a timed-out turn"));
      break;
    }
    await sleep(200);
  }
  probe = await page.evaluate((i) => window.__harnessBench.read(i), index);
  await page.evaluate((i) => window.__harnessBench.disarm(i), index);
  const logged = readLogSince(instance.log, instance.logOffset);
  instance.logOffset = logged.offset;
  const server = parseHarnessLog(logged.text);
  const request = probe.requests[probe.requests.length - 1] ?? null;
  if (!failure) {
    if (!request) failure = "no_request";
    else if (request.error) failure = `request_error:${request.error.slice(0, 80)}`;
    else if (request.status !== 200) failure = `http_${request.status}`;
    else if (request.firstTextDelta === null) failure = "no_text";
    else if (probe.painted === null) failure = "not_painted";
    else if (spec.expect && !spec.expect.test(request.text)) failure = "unexpected_text";
  }
  let verified = null;
  if (spec.markers) {
    const outputs = probe.requests.flatMap((r) => r.toolOutputs).map((o) => o.output).join("\n");
    verified = spec.markers.every((m) => outputs.includes(m));
    if (!failure && !verified) failure = "echo_unverified";
  }
  const send = probe.send;
  const chatSessionId = probe.requests.map((r) => r.chatSessionId).find(Boolean) ?? null;
  const reusedChat = workload !== "followup" && chatSessionId !== null && chatSessionId === instance.lastChatSessionId;
  if (chatSessionId) instance.lastChatSessionId = chatSessionId;
  if (!failure && reusedChat) failure = "reused_chat";
  const row = {
    run: args.run, ...meta, instance: instance.name, label: instance.label, client: args.client,
    workload, ok: failure === null, failure, verified, approvals, requests: probe.requests.length,
    chatSessionId, at: new Date(wallStart).toISOString(),
    error: request ? { status: request.status, body: request.errorBody ?? null, stream: request.streamError ?? null } : null,
    composer: await composerState(page),
    browser: {
      sendKind: probe.sendKind,
      sendToRequest: between(send, request?.start),
      requestToHeaders: between(request?.start, request?.headers),
      headersToFirstChunk: between(request?.headers, request?.firstChunk),
      sendToFirstTextDelta: between(send, request?.firstTextDelta),
      firstTextDeltaToDom: between(request?.firstTextDelta, probe.domText),
      sendToPainted: between(send, probe.painted),
      lastTextToFinish: between(request?.lastTextDelta, request?.finish),
      finishToClose: between(request?.finish, request?.end),
      sendToClose: between(send, request?.end),
      firstSeen: request ? Object.fromEntries(Object.entries(request.firstSeen).map(([k, v]) => [k, between(send, v)])) : null,
      serverTiming: request?.serverTiming ?? null,
      types: request?.types ?? null,
      firstText: request?.firstText ?? null,
      text: request?.text?.slice(0, 300) ?? null,
      dataParts: request?.dataParts ?? [],
    },
    server: { timing: server.timing, turnEvents: server.turnEvents, warnings: server.warnings, trace: server.trace },
  };
  appendFileSync(args.out, JSON.stringify(row) + "\n");
  // The app rotates the session: keep the saved state current after every turn.
  await instance.context.storageState({ path: instance.storage }).catch(bestEffort("save the session"));
  return row;
}

function brief(row) {
  const b = row.browser;
  const t = row.server.timing ?? {};
  const ev = row.server.turnEvents.at(-1) ?? {};
  const why = row.ok ? "" : ` why=${JSON.stringify((row.error?.stream || row.error?.body || "").slice(0, 140))}`;
  return `${row.primer ? "primer " : ""}pair=${row.pair ?? "-"} ${row.instance} ${row.workload} ok=${row.ok}${row.failure ? `(${row.failure})` : ""} send→paint=${b.sendToPainted}ms send→close=${b.sendToClose}ms start=${ev.start ?? "?"} fallback=${ev.fallback_reason ?? "?"} srvFirstText=${t.firstTextMs ?? "?"} sessionConnect=${t.sessionConnect ?? "?"} chat=${(row.chatSessionId ?? "-").slice(0, 6)}${why}`;
}

async function runSequence(instance, args, meta) {
  const rows = [];
  for (const workload of args.workloads) {
    try {
      if (workload !== "followup") await freshChat(instance, args);
      const row = await runTurn(instance, workload, meta, args);
      rows.push(row);
      console.log(brief(row));
      if (!row.ok && workload === "first" && args.workloads.includes("followup")) {
        console.log("  first turn failed; skipping its follow-up");
        break;
      }
    } catch (error) {
      const row = { run: args.run, ...meta, instance: instance.name, label: instance.label, workload, ok: false, failure: `driver:${error.message.split("\n")[0].slice(0, 120)}`, at: new Date().toISOString() };
      appendFileSync(args.out, JSON.stringify(row) + "\n");
      console.log(`${meta.pair ?? "-"} ${instance.name} ${workload} DRIVER ERROR ${error.message.split("\n")[0]}`);
      await instance.page.reload({ waitUntil: "domcontentloaded" }).catch(bestEffort("reload after a driver error"));
      await sleep(5_000);
      await selectClient(instance.page, args.client).catch(bestEffort("reselect the client"));
      break;
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ headless: !args.headed });
  const instances = [];
  try {
    for (const instance of args.instances) await openInstance(browser, instance, args, instances);
    for (let p = 0; p < args.primers; p += 1) {
      for (const instance of instances) {
        await runSequence(instance, { ...args, workloads: ["first"] }, { primer: true, pair: null });
      }
    }
    for (let pair = 0; pair < args.pairs; pair += 1) {
      const order = pair % 2 === 0 ? instances : [...instances].reverse();
      for (const [position, instance] of order.entries()) {
        await runSequence(instance, args, { primer: false, pair, position });
      }
    }
  } finally {
    for (const instance of instances) {
      await instance.context.storageState({ path: instance.storage }).catch(bestEffort("save the session at exit"));
      await instance.context.close().catch(bestEffort("close the context"));
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
