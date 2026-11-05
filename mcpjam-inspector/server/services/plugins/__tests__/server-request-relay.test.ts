import { afterEach, expect, it, vi } from "vitest";
import {
  createServerRequestRelay,
  isJsonRpcResponse,
  requestDeadline,
} from "../shim/server-request-relay.mjs";

afterEach(() => vi.useRealTimers());
const request = (id: string | number, text = "") => ({
  jsonrpc: "2.0",
  id,
  method: "openai/elicitation/create",
  params: { text },
});
function relay(timeoutMs = 100) {
  const send = vi.fn();
  const release = vi.fn();
  const controller = new AbortController();
  const instance = createServerRequestRelay({
    send,
    timeoutMs,
    beginInput: () => ({ release, signal: controller.signal }),
  });
  return { instance, send, release, controller };
}
it("bounds pending requests and payloads before retaining them", () => {
  const { instance, send, release } = relay();
  for (let i = 0; i < 17; i++) instance.receive(request(i));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].id).toBe(16);
  instance.close();
  expect(release).toHaveBeenCalledTimes(16);
  const oversized = relay();
  oversized.instance.receive(request("large", "x".repeat(1024 * 1024)));
  expect(oversized.send).toHaveBeenCalledOnce();
  expect(oversized.release).not.toHaveBeenCalled();
  const total = relay();
  for (let i = 0; i < 5; i++)
    total.instance.receive(request(i, "x".repeat(900_000)));
  expect(total.send).toHaveBeenCalledOnce();
  total.instance.close();
});
it("rejects unknown, duplicate, mismatched-type and late replies", () => {
  const { instance, send, release } = relay();
  instance.receive(request(8));
  instance.receive(request(8));
  expect(send).toHaveBeenCalledOnce();
  expect(instance.respond({ jsonrpc: "2.0", id: 8, result: {} })).toBe(false);
  instance.receive(request(7));
  expect(
    instance.respond({
      jsonrpc: "2.0",
      id: 7,
      result: "x".repeat(1024 * 1024),
    }),
  ).toBe(false);
  expect(instance.respond({ jsonrpc: "2.0", id: "7", result: {} })).toBe(false);
  expect(instance.respond({ jsonrpc: "2.0", id: 7, result: {} })).toBe(true);
  expect(instance.respond({ jsonrpc: "2.0", id: 7, result: {} })).toBe(false);
  expect(release).toHaveBeenCalledTimes(2);
});
it("expires input, and never accepts it after the parent ends", () => {
  vi.useFakeTimers();
  const first = relay();
  first.instance.receive(request("timeout"));
  vi.advanceTimersByTime(100);
  expect(first.release).toHaveBeenCalledOnce();
  expect(
    first.instance.respond({ jsonrpc: "2.0", id: "timeout", result: {} }),
  ).toBe(false);
  const second = relay();
  second.instance.receive(request("cancel"));
  second.controller.abort();
  expect(second.send).toHaveBeenCalledOnce();
  expect(
    second.instance.respond({ jsonrpc: "2.0", id: "cancel", result: {} }),
  ).toBe(false);
});
it("refuses a server request without an unambiguous live parent", () => {
  const send = vi.fn();
  const instance = createServerRequestRelay({ send, beginInput: () => null });
  instance.receive(request(1));
  expect(send).toHaveBeenCalledOnce();
  expect(instance.respond({ jsonrpc: "2.0", id: 1, result: {} })).toBe(false);
});
it("suspends only the remaining parent budget, reference counts waits, and keeps a hard cap", () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const timer = requestDeadline(expired, 100);
  vi.advanceTimersByTime(30);
  const first = timer.pause();
  const second = timer.pause();
  vi.advanceTimersByTime(1000);
  first();
  vi.advanceTimersByTime(1000);
  expect(expired).not.toHaveBeenCalled();
  second();
  vi.advanceTimersByTime(69);
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expired).toHaveBeenCalledOnce();
  timer.stop();
  const hard = requestDeadline(expired, 100);
  hard.pause();
  vi.advanceTimersByTime(300100);
  expect(expired).toHaveBeenCalledTimes(2);
  hard.stop();
});
it("validates response shape before forwarding", () => {
  expect(isJsonRpcResponse(null)).toBe(false);
  expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: "wrong" })).toBe(
    false,
  );
  expect(
    isJsonRpcResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -1, message: "declined" },
    }),
  ).toBe(true);
  expect(
    isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {}, error: {} }),
  ).toBe(false);
});

it("keeps the largest accepted Node deadline from overflowing to one millisecond", () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const deadline = requestDeadline(expired, 2_147_483_647);
  vi.advanceTimersByTime(1000);
  expect(expired).not.toHaveBeenCalled();
  deadline.stop();
});
