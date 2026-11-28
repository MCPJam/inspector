import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESOLVE_TIMEOUT_MS,
  serverOnPrivateNetwork,
} from "../probes/private-target.js";

const PUBLIC = "93.184.216.34";

describe("serverOnPrivateNetwork", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("judges an address literal without resolving it", async () => {
    const resolve = vi.fn(async () => [PUBLIC]);
    expect(await serverOnPrivateNetwork("http://127.0.0.1:3000/mcp", resolve)).toBe(true);
    expect(await serverOnPrivateNetwork("http://10.1.2.3/mcp", resolve)).toBe(true);
    expect(await serverOnPrivateNetwork("http://[::1]:3000/mcp", resolve)).toBe(true);
    expect(await serverOnPrivateNetwork(`https://${PUBLIC}/mcp`, resolve)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("calls a loopback name private without resolving it", async () => {
    const resolve = vi.fn(async () => [PUBLIC]);
    expect(await serverOnPrivateNetwork("http://localhost:3000/mcp", resolve)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("calls a name private only when every address it resolves to is", async () => {
    expect(
      await serverOnPrivateNetwork("https://nas.lan/mcp", async () => [
        "192.168.1.20",
        "fd00::20",
      ]),
    ).toBe(true);
    expect(
      await serverOnPrivateNetwork("https://mixed.example/mcp", async () => [
        "192.168.1.20",
        PUBLIC,
      ]),
    ).toBe(false);
    expect(
      await serverOnPrivateNetwork("https://srv.example.com/mcp", async () => [PUBLIC]),
    ).toBe(false);
  });

  it("calls a name public when it does not resolve, or resolves to nothing", async () => {
    expect(
      await serverOnPrivateNetwork("https://gone.example/mcp", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe(false);
    expect(await serverOnPrivateNetwork("https://empty.example/mcp", async () => [])).toBe(
      false,
    );
    expect(await serverOnPrivateNetwork("not a url", async () => ["10.0.0.1"])).toBe(false);
  });

  it("calls a name public when resolving it outlasts the timeout", async () => {
    vi.useFakeTimers();
    let settled: boolean | undefined;
    void serverOnPrivateNetwork(
      "https://slow.example/mcp",
      () => new Promise<string[]>(() => undefined),
    ).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
  });
});
