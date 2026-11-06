import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { chromium } from "playwright";
import { NotFoundError } from "e2b";
import { acquirePlaygroundHarnessBox } from "../../server/utils/harness/playground-box.ts";
import { attachRunningSandbox } from "../../server/utils/computers/attach-sandbox.ts";
import { releaseSandbox } from "../../server/utils/computers/control-plane-client.ts";
import { getHarnessAdapter } from "../../server/utils/harness/registry.ts";
import { observeProcesses } from "./process-observer.mjs";
import { openPlaygroundArm } from "./playground-arm.mjs";
import { openGatewayCli } from "./gateway-cli.mjs";
import { primeMatched, withMeasurementWindow } from "./matched-priming.mjs";
import { schedule, verdict } from "./qualification.mjs";
import {
  digest,
  cliSignature,
  readEvidence,
  saveEvidence,
  cleanupAll,
  runConcurrent,
  validateOutput,
  failedMeasurement,
  fixtureSnapshot,
  assertFollowupWindow,
} from "./evidence.mjs";
import { setTimeout as delay } from "node:timers/promises";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
if (config.projectId !== process.env.HARN24_QA_PROJECT_ID)
  throw Error("Select the internal QA project.");
await mkdir(config.output, { recursive: true });
const browser = await chromium.connectOverCDP(config.cdp);
const context = browser.contexts()[0],
  opener = context.pages().find((p) => p.url().startsWith(config.url));
if (!opener) throw Error("Open the signed-in development Playground.");
let bearer = JSON.parse(
  await readFile(config.bearerFile, "utf8"),
).authorization;
context.on("request", (request) => {
  const auth = request.headers().authorization;
  if (
    new URL(request.url()).origin === new URL(config.url).origin &&
    auth?.startsWith("Bearer ")
  )
    bearer = auth;
});
let uiTail = Promise.resolve();
async function ui(fn) {
  const prior = uiTail;
  let release;
  uiTail = new Promise((r) => {
    release = r;
  });
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}
const prime = "Respond with only READY",
  ready = "READY";
const trios = [];
const sources = await Promise.all(
  [
    "run-pilot",
    "evidence",
    "gateway-cli",
    "gateway-baseline",
    "native-cli",
    "native-identity",
    "playground-arm",
    "browser-trace",
    "playground-clock",
    "qualification",
    "process-observer",
    "matched-priming",
  ].map((n) =>
    readFile(
      new URL(
        "./" + n + (n === "gateway-baseline" ? ".ts" : ".mjs"),
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const manifestHash = digest({
  config: { ...config, indices: undefined, output: undefined },
  sources,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
});
const manifestFile = config.output + "/manifest.json";
const existingManifest = await readEvidence(manifestFile, manifestHash);
if (!existingManifest)
  await saveEvidence(manifestFile, {
    manifestHash,
    config: { ...config, bearerFile: undefined },
  });

async function runPair(plan, host) {
  const arms = {},
    boxes = {},
    connections = {},
    observers = {},
    primers = {},
    before = {},
    chatIds = {};
  let cli, primaryError;
  const file =
    config.output +
    "/" +
    plan.client +
    "-" +
    plan.workload +
    "-" +
    plan.index +
    ".json";
  const prior = await readEvidence(file, manifestHash);
  // Interrupted slots remain misses, rather than being rerun until they pass.
  if (prior) {
    trios.push(prior);
    return;
  }
  const nativeModel = getHarnessAdapter(plan.client).toNativeModel(
    host.modelId,
  );
  if (nativeModel !== host.nativeModel)
    throw Error("The CLI and Playground native models differ.");
  const allocation = randomInt(2) ? ["on", "off"] : ["off", "on"];
  try {
    for (const arm of allocation) {
      process.stdout.write(
        `Preparing ${plan.client}/${plan.workload}/${arm}\n`,
      );
      primers[arm] = await ui(async () => {
        arms[arm] = await openPlaygroundArm(context, opener, {
          ...host,
          projectId: config.projectId,
          url: config.url,
          chatApiUrl: config.endpoints[arm] + "/api/web/chat-v2",
          onAuthorization: (auth) => {
            bearer = auth;
          },
          beforeFirstDispatch: async (chatSessionId, currentBearer) => {
            if (currentBearer?.startsWith("Bearer ")) bearer = currentBearer;
            const acquired = await acquirePlaygroundHarnessBox({
              bearer,
              projectId: config.projectId,
              chatSessionId,
              harness: plan.client,
            });
            if (!acquired.ok)
              throw Error(
                "Could not acquire the QA box: " + acquired.refusal.error,
              );
            boxes[arm] = acquired.box.binding;
            await acquired.box.release();
            connections[arm] = await attachRunningSandbox(
              boxes[arm].sandboxId,
              { signal: AbortSignal.timeout(30000) },
            );
            observers[arm] = await observeProcesses(
              connections[arm],
              plan.client,
            );
          },
        });
        return arms[arm].send(prime, "text", undefined, ready);
      });
      chatIds[arm] = arms[arm].chatId;
      process.stdout.write(`Primed ${plan.client}/${plan.workload}/${arm}\n`);
    }
    if (
      chatIds.on === chatIds.off ||
      boxes.on.sandboxId === boxes.off.sandboxId
    )
      throw Error("Benchmark arms must be independent.");
    cli = await openGatewayCli(
      {
        projectId: config.projectId,
        chatSessionId: chatIds.on,
        bearer,
        harnessId: plan.client,
        modelId: host.modelId,
        modelSelection: host.modelSelection,
        reasoningEffort: host.effort,
      },
      {
        model: nativeModel,
        effort: host.effort,
        systemPrompt: host.systemPrompt,
        servers: host.cliServers,
        getBearer: () => arms.on.authorization(),
        toolName: plan.workload === "tool" ? host.cliToolName : undefined,
      },
    );
    const prompt =
      plan.workload === "text" ? "Respond with only MEASURED" : host.toolPrompt;
    const {
      primers: aligned,
      cliPrimer,
      history,
      matchId,
    } = await ui(() =>
      primeMatched({
        paths: plan.paths,
        arms,
        cli,
        host,
        prime,
        ready,
        prompt,
        serialize: (fn) => fn(),
      }),
    );
    Object.assign(primers, aligned);
    for (const arm of ["on", "off"])
      before[arm] = await observers[arm].latest();
    const row = {
      ...plan,
      order: plan.paths,
      allocation,
      chatIds,
      manifestHash,
      matchId,
      status: "measuring",
      sandboxIds: { on: boxes.on.sandboxId, off: boxes.off.sandboxId },
      batchId: config.batchId,
    };
    for (const path of plan.paths)
      row[path] = {
        failed: true,
        ms: 60000,
        followupMs: null,
        reason: "not-submitted",
        sandboxId: boxes[path === "cli" ? "on" : path].sandboxId,
        matchId,
      };
    await saveEvidence(file, row);
    await withMeasurementWindow(primers, plan.waitMs, ui, async () => {
      for (const path of plan.paths) {
        const ended =
          path === "cli" ? cliPrimer.endedAt : primers[path].endedAt;
        await delay(Math.max(0, ended + plan.waitMs - Date.now()));
        row[path].reason = "submission-started";
        await saveEvidence(file, row);
        try {
          const beforeFixture = await fixtureSnapshot(config.fixtureStatsUrl);
          assertFollowupWindow(Date.now() - ended, plan.window);
          if (path === "cli") {
            const sample = await cli.turn({ prompt, workload: plan.workload });
            row.cli = {
              ...sample.result,
              matchId: cliSignature(sample.result.configuration, host, history),
              leaseMs: sample.leaseMs,
              boxMs: sample.boxMs,
              followupMs: sample.result.submittedAt - cliPrimer.endedAt,
              nativeProcess: {
                before: cliPrimer.nativeIdentity,
                after: sample.result.nativeIdentity,
              },
            };
          } else {
            const sample = await arms[path].send(
              prompt,
              plan.workload,
              host.uiToolName,
            );
            row[path] = {
              ...sample,
              sandboxId: boxes[path].sandboxId,
              followupMs: sample.submittedAt - primers[path].endedAt,
              nativeProcess: {
                before: before[path],
                after: await observers[path].latest(),
              },
            };
          }
          const afterFixture = await fixtureSnapshot(config.fixtureStatsUrl);
          assertFollowupWindow(row[path].followupMs, plan.window);
          const receipts = afterFixture.methods
            .slice(beforeFixture.methods.length)
            .filter((event) => event.method === "tools/call");
          const toolCalls = receipts.length;
          row[path] = {
            ...validateOutput(row[path], plan.workload, toolCalls),
            fixtureToolCalls: toolCalls,
            fixtureReceipts: receipts,
          };
          if (row[path].matchId !== matchId)
            throw Error("The measured input differs from the other arms.");
        } catch (error) {
          row[path] = failedMeasurement(row[path], error);
          if (Number.isFinite(row[path].submittedAt))
            row[path].followupMs = row[path].submittedAt - ended;
          await saveEvidence(file, row);
          if (path !== "cli") await arms[path].stop();
          break;
        }
        await saveEvidence(file, row);
      }
    });
    row.status = "complete";
    await saveEvidence(file, row);
    trios.push(row);
    process.stdout.write(
      JSON.stringify({
        client: plan.client,
        workload: plan.workload,
        index: plan.index,
        ms: { off: row.off.ms, on: row.on.ms, cli: row.cli.ms },
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(`Pair setup failed: ${error.message}\n`);
    primaryError = error;
    throw error;
  } finally {
    const jobs = [() => cli?.close()],
      retirements = [];
    for (const arm of ["on", "off"]) {
      jobs.push(
        () => observers[arm]?.close(),
        () => arms[arm]?.close(),
      );
      if (boxes[arm])
        retirements.push(async () => {
          await releaseSandbox({
            sandboxRowId: boxes[arm].sandboxRowId,
            signal: AbortSignal.timeout(15000),
          });
          try {
            await connections[arm]?.getInfo();
          } catch (error) {
            if (error instanceof NotFoundError) return;
            throw error;
          }
          await connections[arm]?.kill();
          throw Error(
            "The backend did not confirm retirement; the captured QA box was stopped.",
          );
        });
    }
    const errors = [];
    try {
      await cleanupAll(jobs);
    } catch (error) {
      errors.push(error);
    }
    try {
      await cleanupAll(retirements);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(
        [...(primaryError ? [primaryError] : []), ...errors],
        "Benchmark cleanup failed.",
      );
  }
}
try {
  const plans = config.hosts.flatMap((host) =>
    ["text", "tool"].flatMap((workload) =>
      schedule(host.harness, workload)
        .filter((p) =>
          (config.indices ?? Array.from({ length: 40 }, (_, i) => i)).includes(
            p.index,
          ),
        )
        .map((plan) => ({ host, plan })),
    ),
  );
  // Two pairs use the four permitted sandbox slots. Submit browser turns
  // serially so each measured page remains foregrounded.
  for (const host of config.hosts) {
    const queue = plans.filter((item) => item.host === host);
    await runConcurrent(
      queue,
      Math.min(2, config.parallelPairs ?? 1),
      ({ plan, host }) => runPair(plan, host),
    );
  }
  await saveEvidence(config.output + "/verdict.json", {
    manifestHash,
    verdicts: config.hosts.map((h) =>
      verdict(trios, h.harness, config.safetyPassed === true),
    ),
  });
} finally {
  await browser.close();
}
