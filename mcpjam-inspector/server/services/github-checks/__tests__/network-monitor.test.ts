import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../utils/logger";
import {
  parseConnectionRecord,
  startNetworkMonitor,
  stopNetworkMonitor,
} from "../network-monitor";
import { NETWORK_MONITOR_SCRIPT } from "../network-monitor-script";
import type { CheckSandbox } from "../sandbox";

vi.mock("../../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

const context = {
  triggerId: "trusted-trigger",
  repoFullName: "acme/repo",
  prNumber: 1,
  policyVersion: "private-networks-v1",
  policySource: "default" as const,
  denyOut: ["10.0.0.0/8"],
};
const connection = {
  kind: "connection",
  destinationIp: "10.0.0.1",
  destinationPort: 443,
  family: 4,
  protocol: "tcp",
  outcome: "attempted",
  timestamp: 1,
};
const stops: CheckSandbox[] = [];
afterEach(async () => {
  for (const sandbox of stops.splice(0)) await stopNetworkMonitor(sandbox);
  vi.useRealTimers();
  vi.clearAllMocks();
});

function fake() {
  let stdout!: (s: string) => void;
  let rejectWait!: (error: Error) => void;
  const handle = {
    disconnect: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(true),
    wait: () =>
      new Promise((_, reject) => {
        rejectWait = reject;
      }),
  };
  const sandbox = {
    sandboxId: "trusted-sandbox",
    commands: {
      run: vi.fn(async (_cmd, opts) => {
        stdout = opts.onStdout;
        stdout('{"kind":"ready"}\n');
        return handle;
      }),
    },
  } as unknown as CheckSandbox;
  stops.push(sandbox);
  return {
    sandbox,
    handle,
    stdout: (s: string) => stdout(s),
    fail: () => rejectWait(new Error("SECRET_STDERR")),
  };
}

describe("network diagnostics boundary", () => {
  it("copies only valid network fields, excluding guest-provided context and secrets", () => {
    const row = parseConnectionRecord(
      JSON.stringify({ ...connection, headers: "SECRET", triggerId: "spoof" }),
    );
    expect(row).toMatchObject({
      destinationIp: "10.0.0.1",
      outcome: "attempted",
    });
    expect(JSON.stringify(row)).not.toMatch(/SECRET|spoof|headers/);
    for (const bad of [
      { destinationIp: "https://user:SECRET@host" },
      { destinationPort: 0 },
      { outcome: "blocked" },
      { family: 6 },
      { destinationIp: "fe80::1%SECRET", family: 6 },
    ]) {
      expect(
        parseConnectionRecord(JSON.stringify({ ...connection, ...bad })),
      ).toBeNull();
    }
  });
  it("starts before returning, streams split records with trusted IDs, and stops once", async () => {
    const f = fake();
    await startNetworkMonitor(f.sandbox, context);
    const row = JSON.stringify({
      ...connection,
      sandboxId: "spoof",
      triggerId: "spoof",
      body: "SECRET",
    });
    f.stdout(row.slice(0, 20));
    f.stdout(row.slice(20) + "\n");
    expect(logger.info).toHaveBeenCalledWith(
      "[github-checks] network connection",
      expect.objectContaining({
        sandboxId: "trusted-sandbox",
        triggerId: "trusted-trigger",
        outcome: "attempted",
      }),
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toMatch(
      /SECRET|spoof/,
    );
    expect(f.sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("sudo -n python3"),
      expect.objectContaining({ background: true, timeoutMs: 0 }),
    );
    await stopNetworkMonitor(f.sandbox);
    await stopNetworkMonitor(f.sandbox);
    expect(f.handle.kill).toHaveBeenCalledTimes(1);
  });
  it("bounds hostile output and reports dropped records", async () => {
    vi.useFakeTimers();
    const f = fake();
    await startNetworkMonitor(f.sandbox, context);
    f.stdout("x".repeat(2000) + "\n");
    for (let i = 0; i < 200; i++) f.stdout(JSON.stringify(connection) + "\n");
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.filter((c) => c[0].endsWith("network connection")),
    ).toHaveLength(120);
    await vi.advanceTimersByTimeAsync(10000);
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-checks] network monitor dropped records",
      expect.objectContaining({ dropped: 81 }),
    );
  });
  it("disconnects excessive transport output so the SDK cannot keep buffering it", async () => {
    vi.useFakeTimers();
    const f = fake();
    await startNetworkMonitor(f.sandbox, context);
    for (let i = 0; i < 34; i++) f.stdout("x".repeat(65536));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.handle.disconnect).toHaveBeenCalledOnce();
    expect(f.handle.kill).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-checks] network monitor",
      expect.objectContaining({ reason: "transport_limit" }),
    );
  });
  it("reports a silent monitor and bounds cleanup when the provider stops responding", async () => {
    vi.useFakeTimers();
    const f = fake();
    await startNetworkMonitor(f.sandbox, context);
    await vi.advanceTimersByTimeAsync(40000);
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-checks] network monitor",
      expect.objectContaining({ reason: "heartbeat_missing" }),
    );
    f.handle.kill.mockImplementationOnce(() => new Promise(() => {}));
    const stop = stopNetworkMonitor(f.sandbox);
    await vi.advanceTimersByTimeAsync(2000);
    await stop;
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-checks] network monitor",
      expect.objectContaining({ reason: "stop_failed" }),
    );
  });
  it("caps the complete run even when each minute is below its limit", async () => {
    vi.useFakeTimers();
    const f = fake();
    await startNetworkMonitor(f.sandbox, context);
    for (let minute = 0; minute < 21; minute++) {
      f.stdout('{"kind":"heartbeat"}\n');
      for (let i = 0; i < 100; i++) f.stdout(JSON.stringify(connection) + "\n");
      await vi.advanceTimersByTimeAsync(60000);
    }
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.filter((c) => c[0].endsWith("network connection")),
    ).toHaveLength(2000);
  });
  it("reports stream failures without leaking errors or changing the check", async () => {
    const f = fake();
    await startNetworkMonitor(f.sandbox, context);
    f.fail();
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-checks] network monitor",
      expect.objectContaining({ reason: "stream_failed" }),
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      "SECRET",
    );
  });
  it("times out startup without blocking the check and kills a late handle", async () => {
    vi.useFakeTimers();
    let resolve!: (v: unknown) => void;
    const sandbox = {
      sandboxId: "sb",
      commands: {
        run: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    } as unknown as CheckSandbox;
    const start = startNetworkMonitor(sandbox, context);
    await vi.advanceTimersByTimeAsync(5000);
    await start;
    const kill = vi.fn().mockResolvedValue(true);
    resolve({
      kill,
      disconnect: vi.fn().mockResolvedValue(undefined),
      wait: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).toHaveBeenCalledOnce();
  });
  it("does not block a run when dependencies or privileges are missing", async () => {
    const sandbox = {
      sandboxId: "sb",
      commands: { run: vi.fn().mockRejectedValue(new Error("SECRET")) },
    } as unknown as CheckSandbox;
    await expect(
      startNetworkMonitor(sandbox, context),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "[github-checks] network monitor",
      expect.objectContaining({ reason: "start_failed" }),
    );
  });
});

describe("passive packet observer", () => {
  it("observes TCP resets and inferred timeouts, UDP and IPv6 without emitting packet payloads", () => {
    const test = String.raw`
rows=[]
o=Observer(rows.append)
def tcp(src,dst,sport,dport,flags):
    ip=bytes([69,0,0,40,0,0,0,0,64,6,0,0])+socket.inet_aton(src)+socket.inet_aton(dst)
    transport=struct.pack('!HH',sport,dport)+bytes(8)+bytes([80,flags])+bytes(6)
    return ip+transport+b'SECRET-BODY'
o.observe(tcp('192.0.2.2','10.0.0.1',12345,443,2),True,0)
o.observe(tcp('10.0.0.1','192.0.2.2',443,12345,20),False,1)
o.observe(tcp('192.0.2.2','10.0.0.2',12346,443,2),True,2)
o.expire(13)
v6=bytes([96,0,0,0,0,8,17,64])+socket.inet_pton(socket.AF_INET6,'2001:db8::1')+socket.inet_pton(socket.AF_INET6,'2001:db8::2')+struct.pack('!HHHH',1234,53,8,0)
o.observe(v6,True,14)
# Standard ICMP quotes contain only eight TCP bytes, not a full TCP header.
original=tcp('192.0.2.2','10.0.0.3',12347,443,2)
o.observe(original,True,15)
ip=bytes([69,0,0,56,0,0,0,0,64,1,0,0])+socket.inet_aton('10.0.0.3')+socket.inet_aton('192.0.2.2')
o.observe(ip+bytes([3,1,0,0,0,0,0,0])+original[:28],False,16)
o.expire(30)
# A provider can accept SYN then reset the connection after seeing traffic.
o.observe(tcp('192.0.2.2','10.0.0.4',12348,443,2),True,31)
o.observe(tcp('10.0.0.4','192.0.2.2',443,12348,18),False,32)
o.observe(tcp('10.0.0.4','192.0.2.2',443,12348,20),False,33)
print(json.dumps(rows))
`;
    const availability = spawnSync("python3", ["--version"], {
      encoding: "utf8",
    });
    expect(
      availability.error,
      `python3 is required for the network monitor tests: ${availability.error?.message ?? "failed to start"}`,
    ).toBeUndefined();
    expect(
      availability.status,
      `python3 is required for the network monitor tests: ${availability.stderr || availability.stdout}`,
    ).toBe(0);

    const result = spawnSync(
      "python3",
      [
        "-c",
        NETWORK_MONITOR_SCRIPT.replace(
          "if __name__ == '__main__':",
          "if False:",
        ) + test,
      ],
      { encoding: "utf8" },
    );
    expect(
      result.error,
      `python3 failed to start the network monitor test: ${result.error?.message ?? "unknown startup error"}`,
    ).toBeUndefined();
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout);
    expect(rows.map((r: { outcome: string }) => r.outcome)).toEqual([
      "attempted",
      "reset_observed",
      "attempted",
      "timeout_inferred",
      "attempted",
      "attempted",
      "unreachable_observed",
      "attempted",
      "syn_ack_observed",
      "reset_observed",
    ]);
    expect(rows[4]).toMatchObject({
      family: 6,
      protocol: "udp",
      destinationIp: "2001:db8::2",
    });
    expect(result.stdout).not.toContain("SECRET");
  });
});
