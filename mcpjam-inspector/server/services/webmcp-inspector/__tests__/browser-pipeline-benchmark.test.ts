/** Opt-in real Chrome comparison. Default settings first, then matched geometry.
 * Measures marker-bearing frame arrival, not frontend decode or physical display.
 */
import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { PlaywrightWebMcpProvider } from "../playwright-provider";
import {
  createTabViewport,
  type ViewportFrame,
} from "../../browserd/daemon/viewport";
import { buildWebMcpLaunchArgs } from "../launch-args";
import type { CdpLike } from "../../browserd/daemon/webmcp-bridge";
import { startWebMcpFixturePage } from "../../../../e2e/fixtures/webmcp-frame-page";

const enabled = process.env.RUN_BROWSER_PIPELINE_BENCHMARK === "1";
describe.skipIf(!enabled)("actual browser capture/input pipelines", () => {
  it("compares default and matched Node capture paths", async () => {
    const fixture = await startWebMcpFixturePage({ variant: "interaction" });
    const report: unknown[] = [];
    try {
      for (const preset of ["historical", "candidate", "matched"] as const) {
        const matched = preset === "matched";
        for (const engine of ["webmcp", "playground"]) {
          const frames: Array<{ data: string; width: number; at: number }> = [];
          const record = (f: { data: string; deviceWidth: number }) =>
            frames.push({ data: f.data, width: f.deviceWidth, at: Date.now() });
          let dispose: () => Promise<void>;
          let input: () => Promise<void>;
          let version = "provider-managed";
          const viewport =
            (engine === "webmcp" && preset === "historical") || matched
              ? { width: 1280, height: 800 }
              : { width: 600, height: 700 };
          const dpr = preset === "historical" && engine === "webmcp" ? 2 : 1;
          if (engine === "webmcp") {
            const session = await new PlaywrightWebMcpProvider().createSession({
              url: fixture.url,
              viewportMode: "embedded",
              devicePixelRatio: dpr,
              callbacks: {
                onToolsChanged() {},
                onNavigated() {},
                onPopupOpened() {},
                onExternalInvocation() {},
                onActivityObserved() {},
                onCrashed() {},
                onFrame: record,
              },
            });
            if (preset === "candidate") {
              await session.resizeViewport!(viewport.width, viewport.height);
              frames.length = 0;
            }
            dispose = () => session.dispose();
            input = () =>
              session.dispatchInput([
                { kind: "wheel", x: 300, y: 300, deltaX: 0.2, deltaY: 40 },
              ]);
          } else {
            const browser = await chromium.launch({
              headless: true,
              args: buildWebMcpLaunchArgs(),
            });
            version = browser.version();
            const context = await browser.newContext({
              viewport,
              deviceScaleFactor: dpr,
            });
            const page = await context.newPage();
            await page.goto(fixture.url);
            const cdp = await context.newCDPSession(page);
            const stream = createTabViewport(cdp as unknown as CdpLike, {
              surface: viewport,
            });
            stream.subscribe((f: ViewportFrame) => record(f));
            dispose = async () => {
              await stream.dispose();
              await browser.close();
            };
            input = () => {
              stream.boost(33, 1500);
              return stream.dispatchInput([
                { type: "wheel", x: 300, y: 300, deltaX: 0.2, deltaY: 40 },
              ]);
            };
          }
          try {
            await expect
              .poll(() => frames.length, { timeout: 10000 })
              .toBeGreaterThan(0);
            const samples = [];
            for (
              let gesture = 1;
              gesture <= Number(process.env.BROWSER_PIPELINE_SAMPLES ?? 30);
              gesture++
            ) {
              frames.length = 0;
              const start = Date.now();
              await input();
              const dispatched = Date.now() - start;
              let scanned = 0;
              let arrival: number | undefined;
              await expect
                .poll(
                  async () => {
                    while (scanned < frames.length) {
                      const f = frames[scanned++];
                      const { data, info } = await sharp(
                        Buffer.from(f.data, "base64"),
                      )
                        .extract({
                          left: f.width - 128,
                          top: 0,
                          width: 128,
                          height: 16,
                        })
                        .removeAlpha()
                        .raw()
                        .toBuffer({ resolveWithObject: true });
                      let marker = 0;
                      for (let bit = 0; bit < 8; bit++)
                        if (
                          data[
                            (8 * info.width + bit * 16 + 8) * info.channels
                          ] > 128
                        )
                          marker |= 1 << bit;
                      if (marker === gesture) {
                        arrival = f.at - start;
                        return true;
                      }
                    }
                    return false;
                  },
                  { timeout: 10000, interval: 20 },
                )
                .toBe(true);
              samples.push({
                dispatchMs: dispatched,
                markerArrivalMs: arrival,
              });
            }
            report.push({
              engine,
              preset,
              matched,
              viewport,
              dpr,
              version,
              samples,
            });
          } finally {
            await dispose();
          }
        }
      }
      await writeFile(
        process.env.BROWSER_PIPELINE_REPORT ??
          "/private/tmp/browser-pipeline-report.json",
        JSON.stringify(
          {
            machine: os.cpus()[0]?.model,
            platform: os.platform(),
            node: process.version,
            report,
          },
          null,
          2,
        ),
      );
    } finally {
      await fixture.close();
    }
  }, 180000);
});
