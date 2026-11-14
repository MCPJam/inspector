import * as nodeStream from "node:stream";
import * as nodeChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { patchWarmClaudeQuery } from "../warm-claude-query.js";

// Exercise the code injected into the real bridge, including its prompt gate.
const stub = `const q = claudeSdk.query({abortSignal: abortCtl.signal
    }
  });
const [input, extra] = handlerArgs;
      });
      emit({
        type: "tool-result",
        toolCallId,
await q.return?.(void 0);
mcpjamDrainController.clear();`;
const injected = patchWarmClaudeQuery(stub);
const sessionCode = injected.slice(injected.indexOf("var mcpjamWarmClaude,"))
  .replace('await import("node:stream")', "nodeStream")
  .replace('await import("node:child_process")', "nodeChildProcess");
afterEach(() => vi.useRealTimers());

async function fixture() {
  const query = {
    setMcpServers: vi.fn(async () => ({ errors: {} })),
    mcpServerStatus: vi.fn(async () => [{ name: "fixture", status: "connected" }]),
    close: vi.fn(),
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }),
  };
  const build = new Function("claudeSdk", "nodeStream", "nodeChildProcess", `${sessionCode}; return {
    open: mcpjamOpenClaudeTurn, state: () => mcpjamWarmClaude
  };`);
  const sdk = { query: vi.fn(() => query) };
  const runtime = build(sdk, nodeStream, nodeChildProcess);
  const controller = new AbortController();
  const options = { mcpServers: { fixture: { type: "http", url: "https://fixture.invalid" } } };
  await runtime.open({ options, prompt: (async function* () {})() }, { abortSignal: controller.signal }, {});
  const retained = runtime.state();
  retained.owner = undefined;
  const writes: unknown[] = [];
  retained.input.on("data", (value: unknown) => writes.push(value));
  const next = (start: object) =>
    runtime.open({ options, prompt: (async function* () { yield { uuid: "next" }; })() }, { abortSignal: controller.signal }, start);
  return { query, sdk, runtime, writes, next, open: () => next({}) };
}

it("waits past the attach budget for confirmed MCP readiness before supplying a prompt", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  f.query.mcpServerStatus.mockImplementation(async () => [{ name: "fixture", status: "pending" }]);
  const pending = f.open();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.writes).toEqual([]);
  expect(f.query.close).not.toHaveBeenCalled();
  f.query.mcpServerStatus.mockResolvedValue([{ name: "fixture", status: "connected" }]);
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(f.writes).toEqual([{ uuid: "next" }]);
});

it("retires an unready process at the MCP deadline without supplying a prompt", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  f.query.mcpServerStatus.mockResolvedValue([{ name: "fixture", status: "pending" }]);
  const pending = expect(f.open()).rejects.toThrow("did not confirm");
  await vi.advanceTimersByTimeAsync(30_000);
  await pending;
  expect(f.writes).toEqual([]);
  expect(f.query.close).toHaveBeenCalledOnce();
  expect(f.runtime.state()).toBeUndefined();
});

it("restarts the CLI from disk when a warm turn's environment changes, such as Claude Code's quiet start", async () => {
  const f = await fixture();
  await f.open();
  expect(f.sdk.query).toHaveBeenCalledOnce();
  f.runtime.state().owner = undefined;
  await f.next({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  expect(f.query.close).toHaveBeenCalledOnce();
  expect(f.sdk.query).toHaveBeenCalledTimes(2);
});
