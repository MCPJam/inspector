import net from "net";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeFreePort,
  resolveServerPortAttempts,
  resolveServerStartPort,
  SERVER_PORT_PINNED_ENV,
} from "./server-port-fallback.js";

describe("resolveServerStartPort", () => {
  it("starts from SERVER_PORT when the launcher set a valid one", () => {
    expect(resolveServerStartPort({ SERVER_PORT: "6276" }, 6274)).toBe(6276);
    expect(resolveServerStartPort({ SERVER_PORT: " 7000 " }, 6274)).toBe(7000);
  });

  it("keeps the default when SERVER_PORT is unset, empty or not a port", () => {
    expect(resolveServerStartPort({}, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "" }, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "auto" }, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "0" }, 6274)).toBe(6274);
    expect(resolveServerStartPort({ SERVER_PORT: "70000" }, 6274)).toBe(6274);
  });
});

describe("resolveServerPortAttempts", () => {
  it("allows exactly one attempt when the launcher pinned the renderer", () => {
    expect(
      resolveServerPortAttempts({ [SERVER_PORT_PINNED_ENV]: "1" }, 10),
    ).toBe(1);
  });

  it("keeps the fallback walk otherwise", () => {
    expect(resolveServerPortAttempts({}, 10)).toBe(10);
    expect(
      resolveServerPortAttempts({ [SERVER_PORT_PINNED_ENV]: "0" }, 10),
    ).toBe(10);
  });
});

describe("a pinned port that another process holds", () => {
  let holder: net.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) =>
      holder ? holder.close(() => resolve()) : resolve(),
    );
    holder = undefined;
  });

  it("fails instead of falling forward to the next port", async () => {
    // A real listener on an ephemeral port: exactly the reviewer's
    // reproduction, where main used to bind port+1 while the renderer's
    // proxy kept calling the occupied port.
    holder = net.createServer();
    const occupied = await new Promise<number>((resolve) =>
      holder!.listen(0, "localhost", () =>
        resolve((holder!.address() as net.AddressInfo).port),
      ),
    );
    const env = {
      SERVER_PORT: String(occupied),
      [SERVER_PORT_PINNED_ENV]: "1",
    };
    await expect(
      probeFreePort(
        "localhost",
        resolveServerStartPort(env, 6274),
        resolveServerPortAttempts(env, 10),
      ),
    ).rejects.toThrow(/No free port available after 1 attempts/);
  });
});
