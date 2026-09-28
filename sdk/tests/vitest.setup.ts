import { vi } from "vitest";

Object.assign(globalThis, {
  jest: Object.assign(vi, {
    requireActual: vi.importActual.bind(vi),
  }),
});

// Unit tests do not discover the checkout running the test; git discovery has dedicated temporary-repository tests.
process.env.MCPJAM_GIT_AUTODETECT = "false";
