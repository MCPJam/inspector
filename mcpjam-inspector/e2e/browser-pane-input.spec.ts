/** Real Chromium compatibility events: jsdom PointerEvent.detail cannot prove this. */
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

let script: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BrowserPaneSurface } from './client/src/components/browser/BrowserPaneSurface';
        window.inputs = [];
        createRoot(document.getElementById('root')).render(
          <BrowserPaneSurface frame={{deviceWidth:400,deviceHeight:300,scale:1,ts:1,seq:1,src:document.createElement("canvas").toDataURL()}}
            authority={{kind:'shared'}} control="you" onInput={events => window.inputs.push(...events)} />
        );`,
      loader: "tsx",
      resolveDir: packageRoot,
    },
    alias: {
      "@/shared": path.resolve(packageRoot, "shared"),
      "@": path.resolve(packageRoot, "client/src"),
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  script = result.outputFiles[0].text;
});

test("pointer capture preserves browser double/triple click counts and physical key releases", async ({
  page,
}) => {
  // A real origin gives the surface access to localStorage without app auth.
  await page.route("http://pane.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div><style>canvas{width:400px;height:300px}</style>',
    }),
  );
  await page.goto("http://pane.test/");
  await page.addScriptTag({ content: script });
  const canvas = page.getByTestId("rail-browser-frame");
  await expect(canvas).toBeVisible();
  await canvas.click({ clickCount: 3, position: { x: 100, y: 100 } });
  const presses = await page.evaluate(() =>
    (window as any).inputs.filter(
      (e: any) => e.type === "mouse_down" || e.type === "mouse_up",
    ),
  );
  expect(presses.map((e: any) => [e.type, e.clickCount])).toEqual([
    ["mouse_down", 1],
    ["mouse_up", 1],
    ["mouse_down", 2],
    ["mouse_up", 2],
    ["mouse_down", 3],
    ["mouse_up", 3],
  ]);
  // Feed the captured messages to a second real Chromium page: the actual
  // clickCount values must produce a page dblclick and a triple-click press.
  const target = await page.context().newPage();
  await target.setContent(
    '<p>select these words</p><script>window.presses=[];window.doubles=0;addEventListener("mousedown",e=>presses.push(e.detail));addEventListener("dblclick",()=>doubles++)</script>',
  );
  const cdp = await target.context().newCDPSession(target);
  for (const event of presses)
    await cdp.send("Input.dispatchMouseEvent", {
      type: event.type === "mouse_down" ? "mousePressed" : "mouseReleased",
      x: 30,
      y: 15,
      button: "left",
      clickCount: event.clickCount,
    });
  expect(
    await target.evaluate(() => ({
      presses: (window as any).presses,
      doubles: (window as any).doubles,
    })),
  ).toEqual({ presses: [1, 2, 3], doubles: 1 });
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down("A");
  await page.keyboard.up("Shift");
  await page.keyboard.up("a");
  await page.keyboard.up("Control");
  const releases = await page.evaluate(() =>
    (window as any).inputs.filter(
      (e: any) => e.type === "key_up" && e.code === "KeyA",
    ),
  );
  expect(releases).toHaveLength(1);
  expect(releases[0].key).toBe("A");
  await target.close();
  await page.evaluate(() => {
    (window as any).inputs = [];
  });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 100, box.y + 100);
  await page.mouse.up();
  const dragged = await page.evaluate(() => (window as any).inputs);
  expect(dragged.filter((e: any) => e.type === "mouse_up")).toEqual([
    expect.objectContaining({ x: 400, button: "left" }),
  ]);
});

for (const deviceScaleFactor of [1, 2]) {
  test(`stream canvas fits without enlargement at DPR ${deviceScaleFactor}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      deviceScaleFactor,
      viewport: { width: 1000, height: 800 },
    });
    const page = await context.newPage();
    await page.route("http://pane.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        // Include both current and old fill utilities so reverting the component fails.
        body: `<style>
        #root { display:flex; flex-direction:column; width:800px; height:600px }
        .relative { position:relative } .flex { display:flex } .flex-1 { flex:1 1 0% }
        .min-h-0 { min-height:0 } .items-center { align-items:center } .justify-center { justify-content:center }
        .max-w-full { max-width:100% } .max-h-full { max-height:100% }
        .w-full { width:100% } .h-full { height:100% } .object-contain { object-fit:contain }
      </style><div id="root"></div>`,
      }),
    );
    await page.goto("http://pane.test/");
    await page.addScriptTag({ content: script });
    const canvas = page.getByTestId("rail-browser-frame");
    await expect
      .poll(async () => (await canvas.boundingBox())?.width)
      .toBe(400);
    await expect
      .poll(async () => (await canvas.boundingBox())?.height)
      .toBe(300);
    await page.evaluate(() => {
      const root = document.getElementById("root")!;
      root.style.width = "200px";
      root.style.height = "100px";
    });
    await expect
      .poll(async () => (await canvas.boundingBox())?.height)
      .toBeCloseTo(100, 0);
    const box = (await canvas.boundingBox())!;
    expect(box.width).toBeCloseTo(400 / 3, 0);
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    const input = await page.evaluate(() =>
      (window as any).inputs.find((e: any) => e.type === "mouse_down"),
    );
    expect(input.x).toBeCloseTo(200, -1);
    expect(input.y).toBeCloseTo(150, -1);
    await context.close();
  });
}
