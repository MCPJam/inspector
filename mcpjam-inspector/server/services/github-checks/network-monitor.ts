import { isIP } from "node:net";
import { logger } from "../../utils/logger.js";
import type { CheckSandbox } from "./sandbox.js";
import { NETWORK_MONITOR_SCRIPT } from "./network-monitor-script.js";

const LINE_LIMIT = 1024;
const BYTE_LIMIT_PER_MINUTE = 128 * 1024;
const RECORD_LIMIT_PER_MINUTE = 120;
const TOTAL_RECORD_LIMIT = 2000;
const START_TIMEOUT_MS = 5000;
const outcomes = new Set([
  "attempted",
  "syn_ack_observed",
  "reset_observed",
  "unreachable_observed",
  "timeout_inferred",
]);

/** Guest text is untrusted. Copy only validated fields, never spread its JSON. */
export function parseConnectionRecord(line: string) {
  if (line.length > LINE_LIMIT) return null;
  try {
    const row = JSON.parse(line);
    if (
      !row ||
      row.kind !== "connection" ||
      !outcomes.has(row.outcome) ||
      !["tcp", "udp"].includes(row.protocol) ||
      typeof row.destinationIp !== "string" ||
      isIP(row.destinationIp) === 0 ||
      row.destinationIp.includes("%") ||
      isIP(row.destinationIp) !== row.family ||
      !Number.isInteger(row.destinationPort) ||
      row.destinationPort < 1 ||
      row.destinationPort > 65535 ||
      !Number.isSafeInteger(row.timestamp) ||
      row.timestamp < 0
    )
      return null;
    return {
      destinationIp: row.destinationIp as string,
      destinationPort: row.destinationPort as number,
      protocol: row.protocol as string,
      family: row.family as number,
      outcome: row.outcome as string,
      guestTimestamp: row.timestamp as number,
    };
  } catch {
    return null;
  }
}

type Handle = {
  kill(): Promise<unknown>;
  wait(): Promise<unknown>;
  disconnect(): Promise<void>;
};
type MonitorContext = {
  triggerId: string;
  repoFullName: string;
  prNumber: number;
  policyVersion: string;
  policySource: "default" | "override";
  denyOut: string[];
};
const monitors = new WeakMap<CheckSandbox, () => Promise<void>>();

/** Best-effort diagnostics, started before clone/build. Never carries auth env. */
export async function startNetworkMonitor(
  sandbox: CheckSandbox,
  context: MonitorContext,
): Promise<void> {
  const base = {
    ...context,
    sandboxId: sandbox.sandboxId,
    evidence: "guest_observed",
  };
  let stopped = false;
  let handle: Handle | undefined;
  let buffer = "";
  let discardLine = false;
  let lastSeen = Date.now();
  let windowStart = Date.now();
  let bytes = 0,
    records = 0,
    total = 0,
    dropped = 0;
  let transportBytes = 0,
    stderrBytes = 0;
  let reportedMissing = false;
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const warn = (reason: string) =>
    logger.warn("[github-checks] network monitor", { ...base, reason });
  const onStdout = (chunk: string) => {
    if (stopped) return;
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      bytes = records = 0;
    }
    const size = Buffer.byteLength(chunk);
    transportBytes += size;
    // The SDK also buffers command output. Disconnect, rather than merely
    // discarding records, when a tampered monitor exceeds the transport budget.
    if (transportBytes > 2 * 1024 * 1024) {
      warn("transport_limit");
      void stop();
      return;
    }
    bytes += size;
    if (bytes > BYTE_LIMIT_PER_MINUTE || chunk.length > 16_384) {
      dropped++;
      buffer = "";
      discardLine = !chunk.endsWith("\n");
      return;
    }
    for (const char of chunk) {
      if (char !== "\n") {
        if (!discardLine) buffer += char;
        if (buffer.length > LINE_LIMIT) {
          buffer = "";
          discardLine = true;
          dropped++;
        }
        continue;
      }
      const line = buffer;
      buffer = "";
      if (discardLine) {
        discardLine = false;
        continue;
      }
      let control: { kind?: unknown; dropped?: unknown };
      try {
        control = JSON.parse(line);
      } catch {
        dropped++;
        continue;
      }
      if (
        control &&
        ["ready", "heartbeat", "stopped"].includes(String(control.kind))
      ) {
        lastSeen = now;
        if (control.kind === "ready") ready();
        if (
          typeof control.dropped === "number" &&
          Number.isSafeInteger(control.dropped) &&
          control.dropped > 0
        ) {
          dropped += Math.min(control.dropped, 1_000_000);
        }
        continue;
      }
      const record = parseConnectionRecord(line);
      if (
        !record ||
        records >= RECORD_LIMIT_PER_MINUTE ||
        total >= TOTAL_RECORD_LIMIT
      ) {
        dropped++;
        continue;
      }
      lastSeen = now;
      records++;
      total++;
      logger.info("[github-checks] network connection", {
        ...record,
        ...base,
        observedAt: now,
      });
    }
  };
  const flushDropped = () => {
    if (dropped) {
      logger.warn("[github-checks] network monitor dropped records", {
        ...base,
        dropped,
      });
      dropped = 0;
    }
  };
  const heartbeat = setInterval(() => {
    flushDropped();
    if (!reportedMissing && Date.now() - lastSeen > 30_000) {
      reportedMissing = true;
      warn("heartbeat_missing");
    }
  }, 10_000);
  heartbeat.unref?.();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    flushDropped();
    monitors.delete(sandbox);
    if (handle) {
      await handle.disconnect().catch(() => {
        warn("disconnect_failed");
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          handle.kill(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error()), 2000);
          }),
        ]);
      } catch {
        warn("stop_failed");
      } finally {
        clearTimeout(timer);
      }
    }
  };
  monitors.set(sandbox, stop);
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const quoted = `'${NETWORK_MONITOR_SCRIPT.replace(/'/g, `'\\''`)}'`;
    const spawned = sandbox.commands
      .run(`sudo -n python3 -u -c ${quoted}`, {
        background: true,
        timeoutMs: 0,
        onStdout,
        // Never log stderr: interpreter/guest failures can contain arbitrary text.
        onStderr: (chunk) => {
          if (stopped) return;
          stderrBytes += Buffer.byteLength(chunk);
          if (stderrBytes > 4096) {
            warn("stderr_limit");
            void stop();
          }
        },
      })
      .then(async (value) => {
        const candidate = value as Handle;
        if (
          !candidate ||
          typeof candidate.kill !== "function" ||
          typeof candidate.wait !== "function" ||
          typeof candidate.disconnect !== "function"
        )
          throw new Error();
        handle = candidate;
        if (stopped) {
          await candidate.disconnect().catch(() => {});
          await candidate.kill().catch(() => {});
          return;
        }
        void candidate.wait().then(
          () => {
            if (!stopped) {
              warn("exited");
              void stop();
            }
          },
          () => {
            if (!stopped) {
              warn("stream_failed");
              void stop();
            }
          },
        );
      });
    await Promise.race([
      Promise.all([spawned, readiness]),
      new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error()), START_TIMEOUT_MS);
      }),
    ]);
    if (!stopped) logger.info("[github-checks] network monitor started", base);
  } catch {
    warn("start_failed");
    await stop();
  } finally {
    clearTimeout(startupTimer);
  }
}

export async function stopNetworkMonitor(sandbox: CheckSandbox): Promise<void> {
  await monitors.get(sandbox)?.();
}
