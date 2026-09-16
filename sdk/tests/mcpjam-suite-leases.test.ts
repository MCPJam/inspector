import { describe, expect, it, vi } from "vitest";
import { EvalSuite } from "../src/EvalSuite.js";
import { EvalTest } from "../src/EvalTest.js";
import { HostRunner } from "../src/HostRunner.js";
import {
  getMcpjamLeaseClient,
  type McpjamModelLeaseScope,
} from "../src/mcpjam-model-lease.js";

describe("suite-owned model leases", () => {
  it("keeps another suite's leases live when a suite finishes", async () => {
    let mints = 0;
    const revoked: string[] = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith("/revoke")) {
          revoked.push(JSON.parse(init!.body as string).runId);
          return Response.json({ ok: true });
        }
        mints++;
        return Response.json({
          lease: `lease${mints}`,
          runId: `run${mints}`,
          expiresAt: Date.now() + 1800000,
          protocol: "anthropic",
          proxyBaseUrl: "https://proxy.test",
        });
      }
    );
    const scopes: McpjamModelLeaseScope[] = [];
    const runner = HostRunner.mock(() => ({ text: "ok", toolCalls: [] }));
    const clone = runner.withOptions.bind(runner);
    runner.withOptions = (options) => {
      scopes.push(options.mcpjamLeaseScope);
      return clone(options);
    };
    let ready!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const options = {
      baseUrl: "https://app.test",
      apiKey: "sk_test",
      project: "default",
      model: "anthropic/claude-haiku-4.5",
      fetchImpl,
    };
    const first = new EvalSuite({ mcpjam: { enabled: false } });
    first.add(
      new EvalTest({
        id: "c_first",
        name: "first",
        test: async () => {
          await getMcpjamLeaseClient(options, scopes[0]).getLease();
          ready();
          await gate;
          return true;
        },
      })
    );
    const second = new EvalSuite({ mcpjam: { enabled: false } });
    second.add(
      new EvalTest({
        id: "c_second",
        name: "second",
        test: async () => {
          await getMcpjamLeaseClient(options, scopes[1]).getLease();
          return true;
        },
      })
    );
    const pending = first.run(runner, { iterations: 1 });
    await entered;
    await second.run(runner, { iterations: 1 });
    expect(revoked).toEqual(["run2"]);
    expect(
      (await getMcpjamLeaseClient(options, scopes[0]).getLease()).runId
    ).toBe("run1");
    finish();
    await pending;
    expect(revoked).toEqual(["run2", "run1"]);
  });
});
