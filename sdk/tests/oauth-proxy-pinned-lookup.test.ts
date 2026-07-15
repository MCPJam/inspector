// Regression coverage for the pinning DNS lookup inside
// fetchPinnedPublicDocument. With autoSelectFamily (the Node ≥20 default) the
// socket invokes the custom lookup with `all: true` and requires an ARRAY
// callback; answering with a bare string made every CIMD document fetch die
// with ERR_INVALID_IP_ADDRESS ("Invalid IP address: undefined").
import { describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:https", () => ({
  __esModule: true,
  default: { request: requestMock },
  request: requestMock,
}));
vi.mock("node:dns", () => ({
  __esModule: true,
  lookup: lookupMock,
}));

import { fetchPinnedPublicDocument } from "../src/oauth-proxy.js";

type LookupCallbackResult = {
  err: unknown;
  addresses: unknown;
  family: unknown;
};

/** Capture the `lookup` option handed to https.request, failing the request
 * immediately so fetchPinnedPublicDocument's promise settles. */
async function capturePinningLookup(): Promise<
  (hostname: string, options: unknown, cb: (...args: unknown[]) => void) => void
> {
  let captured:
    | ((hostname: string, options: unknown, cb: (...args: unknown[]) => void) => void)
    | undefined;
  requestMock.mockImplementation(
    (_url: unknown, options: { lookup?: typeof captured }) => {
      captured = options.lookup;
      const handlers: Record<string, (err: Error) => void> = {};
      const req = {
        on(event: string, handler: (err: Error) => void) {
          handlers[event] = handler;
          return req;
        },
        end() {
          queueMicrotask(() => handlers.error?.(new Error("stop after capture")));
        },
        destroy() {},
      };
      return req;
    },
  );
  await expect(
    fetchPinnedPublicDocument("https://app.example.com/meta.json"),
  ).rejects.toThrow("stop after capture");
  expect(captured).toBeTypeOf("function");
  return captured!;
}

function invokeLookup(
  lookup: (hostname: string, options: unknown, cb: (...args: unknown[]) => void) => void,
  options: unknown,
): Promise<LookupCallbackResult> {
  return new Promise((resolve) => {
    lookup("app.example.com", options, (err, addresses, family) =>
      resolve({ err, addresses, family }),
    );
  });
}

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6 = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

describe("fetchPinnedPublicDocument pinning lookup", () => {
  it("answers with the address ARRAY when the socket passes all: true (autoSelectFamily)", async () => {
    lookupMock.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) =>
        cb(null, [PUBLIC_V4, PUBLIC_V6]),
    );
    const lookup = await capturePinningLookup();

    const result = await invokeLookup(lookup, { all: true });
    expect(result.err).toBeNull();
    expect(result.addresses).toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  it("answers with a single address + family when all is not set", async () => {
    lookupMock.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) =>
        cb(null, [PUBLIC_V4, PUBLIC_V6]),
    );
    const lookup = await capturePinningLookup();

    const result = await invokeLookup(lookup, { family: 0 });
    expect(result.err).toBeNull();
    expect(result.addresses).toBe(PUBLIC_V4.address);
    expect(result.family).toBe(PUBLIC_V4.family);
  });

  it("rejects when ANY resolved address is private/reserved, in both callback shapes", async () => {
    lookupMock.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) =>
        cb(null, [PUBLIC_V4, { address: "10.0.0.5", family: 4 }]),
    );
    const lookup = await capturePinningLookup();

    for (const options of [{ all: true }, { family: 0 }]) {
      const result = await invokeLookup(lookup, options);
      expect(String(result.err)).toMatch(/private or reserved address \(10\.0\.0\.5\)/);
    }
  });
});
