import { vi } from "vitest";

Object.assign(globalThis, {
  jest: Object.assign(vi, {
    requireActual: vi.importActual.bind(vi),
  }),
});
