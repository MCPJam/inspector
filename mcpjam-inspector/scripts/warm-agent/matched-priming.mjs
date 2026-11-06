import { cliSignature } from "./evidence.mjs";
import { setTimeout as delay } from "node:timers/promises";

// Let other pairs prepare during long idle windows, then reserve the foreground
// lane before the trio is due. Setup from another pair cannot split the trio.
export async function withMeasurementWindow(
  primers,
  waitMs,
  serialize,
  measure,
) {
  const first = Math.min(
    ...Object.values(primers).map((sample) => sample.endedAt),
  );
  await delay(Math.max(0, first + waitMs - 30000 - Date.now()));
  return serialize(measure);
}

function requireReady(result, ready) {
  if (result.failed || result.output.trim() !== ready)
    throw Error(
      `The matched priming response differs (failed=${result.failed}, matches=${result.output.trim() === ready}, status=${result.terminalStatus ?? "browser"}, event=${result.event ?? "none"}).`,
    );
}

// Align the final warm-up order with measurement order. The oldest conversation
// is measured first, rather than ageing behind every other path's setup.
export async function primeMatched({
  paths,
  arms,
  cli,
  host,
  prime,
  ready,
  prompt,
  serialize,
}) {
  const initialCli = await serialize(() =>
    cli.turn({ prompt: prime, workload: "text" }),
  );
  requireReady(initialCli.result, ready);
  const primers = {};
  for (const path of paths) {
    const result = await serialize(() =>
      path === "cli"
        ? cli
            .turn({ prompt: prime, workload: "text" })
            .then((sample) => sample.result)
        : arms[path].send(prime, "text", undefined, ready),
    );
    requireReady(result, ready);
    primers[path] = result;
  }
  const history = [
    ["user", prime],
    ["assistant", ready],
    ["user", prime],
    ["assistant", ready],
    ["user", prompt],
  ];
  return {
    primers,
    cliPrimer: primers.cli,
    history,
    matchId: cliSignature(primers.cli.configuration, host, history),
  };
}
