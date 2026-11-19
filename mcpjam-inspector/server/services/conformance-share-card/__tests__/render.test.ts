import { afterAll, describe, expect, it } from "vitest";
import type { ConformanceShareCardData } from "@/shared/conformance-share-card";
import { isChromiumInstalled } from "../../../utils/browser-rendering-setup.js";
import {
  closeShareCardBrowser,
  renderConformanceShareCardPng,
} from "../render.js";

const CARD: ConformanceShareCardData = {
  serverName: null,
  score: 85.7,
  outcome: "incomplete",
  applicable: 28,
  passed: 24,
  failed: 0,
  couldNotRun: 4,
  notApplicable: 2,
  pending: 0,
  advisoryCount: 0,
  protocolVersion: "2025-11-25",
  suites: [
    { kind: "protocol", applicable: 16, passed: 16, failed: 0, couldNotRun: 0 },
    { kind: "tasks", applicable: 5, passed: 1, failed: 0, couldNotRun: 4 },
  ],
  siteLabel: "app.mcpjam.com",
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// CI's inspector job installs Chromium; elsewhere this draws nothing to check.
const chromium = await isChromiumInstalled();

describe.skipIf(!chromium)("renderConformanceShareCardPng", () => {
  afterAll(() => closeShareCardBrowser());

  it("draws the card as a 1200 × 630 PNG in headless Chromium", async () => {
    const png = await renderConformanceShareCardPng(CARD);
    expect(png).not.toBeNull();
    expect([...png!.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(png!)).toEqual({ width: 1200, height: 630 });
  }, 60_000);

  it("reuses the browser for the next card", async () => {
    const png = await renderConformanceShareCardPng({ ...CARD, score: 100 });
    expect(png && pngSize(png)).toEqual({ width: 1200, height: 630 });
  }, 60_000);
});
