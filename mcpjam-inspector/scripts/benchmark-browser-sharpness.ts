/** Run with tsx --tsconfig server/tsconfig.json; optional first arg is a baseline checkout. */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createTabViewport } from "../server/services/browserd/daemon/viewport";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const baseline = process.argv[2];
const out = process.argv[3] ?? join(tmpdir(), "browser-sharpness-results");
const browser = await chromium.launch({ headless: true, channel: "chromium" });
await mkdir(out, { recursive: true });
const results: unknown[] = [];
try {
  for (const size of [
    { width: 620, height: 1160 },
    { width: 1280, height: 800 },
    { width: 2560, height: 1600 },
  ]) {
    for (const fixture of ["text", "image", "motion"]) {
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      // tsx preserves function names with a helper inside serialized callbacks.
      await page.evaluate("globalThis.__name = (value) => value");
      await page.setContent(
        '<body style="margin:0;background:white"><canvas id="fixture"></canvas></body>',
      );
      await page.evaluate(
        ({ size, fixture }: any) => {
          const c = document.querySelector("canvas")!;
          c.width = size.width;
          c.height = size.height;
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, c.width, c.height);
          if (fixture === "image") {
            const pixels = ctx.createImageData(c.width, c.height);
            let seed = 12345;
            for (let i = 0; i < pixels.data.length; i += 4) {
              seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
              const v = seed >>> 24;
              pixels.data[i] = v;
              pixels.data[i + 1] = v;
              pixels.data[i + 2] = v;
              pixels.data[i + 3] = 255;
            }
            ctx.putImageData(pixels, 0, 0);
          } else {
            ctx.font = "14px monospace";
            ctx.fillStyle = "black";
            for (let y = 20; y < c.height; y += 22)
              ctx.fillText(
                "Browser text: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ · links · fields · readability",
                10,
                y,
              );
          }
        },
        { size, fixture },
      );
      const reference = await page.screenshot({ type: "png" });
      for (const variant of baseline ? ["baseline", "sharp"] : ["sharp"]) {
        const factory =
          variant === "baseline"
            ? (
                await import(
                  pathToFileURL(
                    `${baseline}/mcpjam-inspector/server/services/browserd/daemon/viewport.ts`,
                  ).href
                )
              ).createTabViewport
            : createTabViewport;
        const cdp = await context.newCDPSession(page);
        let frame: any;
        let painted = 0;
        let paint = Promise.resolve();
        // The viewer runs in a separate browser context, as the real inspector does.
        const viewer = await browser.newPage({ viewport: size });
        await viewer.setContent("<canvas></canvas>");
        const viewport = factory(cdp, {
          surface: size,
          ...(variant === "baseline"
            ? { quality: 75, maxFrameBytes: 256 * 1024 }
            : {}),
        });
        const began = performance.now();
        let firstMs: number | undefined;
        viewport.subscribe(
          (f: any) => {
            frame = f;
            paint = paint.then(async () => {
              await viewer.evaluate(async (frame: any) => {
                const image = new Image();
                image.src = `data:image/jpeg;base64,${frame.data}`;
                await image.decode();
                const canvas = document.querySelector("canvas")!;
                canvas.width = image.width;
                canvas.height = image.height;
                canvas.getContext("2d")!.drawImage(image, 0, 0);
              }, f);
              painted++;
            });
            firstMs ??= performance.now() - began;
          },
          variant === "sharp" ? 2 * 1024 * 1024 : undefined,
        );
        await viewport.ready();
        const deadline = Date.now() + 8000;
        while (!frame && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
        await paint;
        await page.evaluate(() => {
          let next = 0;
          document.onmousedown = () => {
            const ctx = document.querySelector("canvas")!.getContext("2d")!;
            ctx.fillStyle = next++ % 2 ? "blue" : "red";
            ctx.fillRect(0, 0, 100, 30);
          };
        });
        // Motion samples alternate a visible marker and wait for the corresponding frame.
        const echoes: number[] = [];
        if (frame && fixture === "motion") {
          for (let i = 0; i < 20; i++) {
            const before = painted;
            const at = performance.now();
            viewport.boost(33, 1500);
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: 50,
              y: 15,
              button: "left",
              clickCount: 1,
            });
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: 50,
              y: 15,
              button: "left",
              clickCount: 1,
            });
            const end = Date.now() + 2000;
            while (painted === before && Date.now() < end)
              await new Promise((r) => setTimeout(r, 5));
            if (painted > before) echoes.push(performance.now() - at);
          }
        }
        const stem = `${variant}-${fixture}-${size.width}x${size.height}`;
        if (frame)
          await writeFile(
            `${out}/${stem}.jpg`,
            Buffer.from(frame.data, "base64"),
          );
        await writeFile(
          `${out}/${fixture}-${size.width}x${size.height}-reference.png`,
          reference,
        );
        const measured = frame
          ? await page.evaluate(
              async ({ jpeg, png }: any) => {
                const load = async (src: string) => {
                  const image = new Image();
                  image.src = src;
                  await image.decode();
                  return image;
                };
                const [a, b] = await Promise.all([
                  load(`data:image/jpeg;base64,${jpeg}`),
                  load(`data:image/png;base64,${png}`),
                ]);
                if (a.width !== b.width || a.height !== b.height)
                  return { width: a.width, height: a.height, psnr: null };
                const c = document.createElement("canvas");
                c.width = a.width;
                c.height = a.height;
                const ctx = c.getContext("2d")!;
                ctx.drawImage(a, 0, 0);
                const x = ctx.getImageData(0, 0, c.width, c.height).data;
                ctx.drawImage(b, 0, 0);
                const y = ctx.getImageData(0, 0, c.width, c.height).data;
                let sum = 0;
                for (let i = 0; i < x.length; i++)
                  if (i % 4 !== 3) sum += (x[i] - y[i]) ** 2;
                return {
                  width: a.width,
                  height: a.height,
                  psnr: 10 * Math.log10(255 ** 2 / (sum / (x.length * 0.75))),
                };
              },
              { jpeg: frame.data, png: reference.toString("base64") },
            )
          : null;
        if (measured && fixture === "motion") measured.psnr = null;
        echoes.sort((a, b) => a - b);
        const result = {
          variant,
          fixture,
          viewport: size,
          firstFrameMs: firstMs,
          frame: measured,
          jpegBytes: frame ? Buffer.from(frame.data, "base64").length : null,
          inputToDrawP95Ms: echoes.length
            ? echoes[Math.ceil(echoes.length * 0.95) - 1]
            : null,
          counters: viewport.counters(),
        };
        results.push(result);
        process.stdout.write(JSON.stringify(result) + "\n");
        await viewport.dispose();
        await cdp.detach();
        await paint;
        await viewer.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
