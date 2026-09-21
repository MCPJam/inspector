import { expect, it } from "vitest";
import { observedToolBinding } from "../browser-tool-binding";
const args = {
  bootId: "boot",
  toolKey: "submit",
  origins: ["https://example.com"],
  stateToken: { tabId: "tab", navCounter: 2, urlHash: "u", domHash: "d" },
  output: {
    tools: [
      {
        name: "submit",
        frameId: "frame",
        registrationSeq: 3,
        origin: "https://example.com",
      },
    ],
  },
};
it("binds to the checked registration, document, tab and boot", () => {
  expect(observedToolBinding(args)).toEqual({
    bootId: "boot",
    tabId: "tab",
    navCounter: 2,
    frameId: "frame",
    registrationSeq: 3,
  });
});
it("refuses missing or ambiguous registrations and foreign frames", () => {
  expect(() => observedToolBinding({ ...args, stateToken: undefined })).toThrow(
    "stale_binding",
  );
  expect(() =>
    observedToolBinding({
      ...args,
      output: { tools: [...args.output.tools, ...args.output.tools] },
    }),
  ).toThrow("stale_binding");
  expect(() =>
    observedToolBinding({ ...args, origins: ["https://other.example"] }),
  ).toThrow("origin_not_allowed");
});
