import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { jsonError } from "../mcp-error-serialize.js";

function fakeContext() {
  const vars: Record<string, unknown> = {};
  return {
    set: (k: string, v: unknown) => {
      vars[k] = v;
    },
    json: (body: unknown, status: number) => ({ body, status }),
    vars,
  };
}

describe("jsonError origin agreement", () => {
  it("ships the same origin on the body as on webErrorMeta", () => {
    // The body used to recompute `originOf(normalized)` while the meta took
    // the capture decision's value. With no boundary at this call site the
    // two coincide today, so this is a contract lock, not a bug repro: if the
    // capture decision ever starts returning a promoted/recorded origin here,
    // the body must follow it rather than silently reverting to the declared
    // catalog value.
    const c = fakeContext();
    const res = jsonError(
      c as never,
      new TypeError("cannot read properties of undefined"),
    ) as unknown as { body: { origin?: string } };

    const meta = c.vars.webErrorMeta as { origin?: string };
    expect(res.body.origin).toBeDefined();
    expect(res.body.origin).toBe(meta.origin);
  });
});
