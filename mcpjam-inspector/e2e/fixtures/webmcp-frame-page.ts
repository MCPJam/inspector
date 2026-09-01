/**
 * A tiny page for the frame-stream E2E: registers a WebMCP tool, and paints
 * something that visibly changes.
 *
 * Served locally rather than pointed at a public demo, for the reason every
 * fixture in this directory exists: an end-to-end test that fails when
 * someone else's site is down is a test people learn to ignore. The page needs
 * only two things from the inspector's point of view — `document.modelContext`
 * has to be there (it is the support probe), and the page has to be tall
 * enough that scrolling changes what is painted.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * How much work the fixture page gives the encoder.
 *
 * `animated` repaints a counter every frame: something always changes, so the
 * measured rate is the throttle's rather than a page that simply stopped.
 * `static` paints once and then never again, which is the case the settle
 * still exists for. `busy` repaints a mosaic of random tiles — deliberately
 * incompressible, so frames are LARGE but still under the cap, and a slow
 * consumer feels the bytes rather than the drops.
 */
export type FixtureVariant = "animated" | "static" | "busy";

const BODY: Record<FixtureVariant, string> = {
  animated: `
      const clock = document.getElementById("clock");
      let ticks = 0;
      function paint() {
        ticks += 1;
        clock.textContent = String(ticks);
        requestAnimationFrame(paint);
      }
      requestAnimationFrame(paint);`,
  static: `
      // Painted exactly once. A page that never repaints is what the settle
      // still is for, and it is also the only way to tell a still apart from
      // a frame: on a page that keeps painting, every frame is a paint.
      document.getElementById("clock").textContent = "static";`,
  busy: `
      // A mosaic of random 8px tiles, redrawn every animation frame. Random
      // pixels do not compress, so each frame is a few hundred KB — large
      // enough to fill a paused consumer's buffers, small enough to stay under
      // the frame cap, which is what makes a slow-consumer test about the
      // SOCKET rather than about oversized frames.
      const canvas = document.getElementById("noise");
      canvas.width = 1280;
      canvas.height = 800;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      const source = document.createElement("canvas");
      source.width = 160;
      source.height = 100;
      const sourceCtx = source.getContext("2d");
      const tiles = sourceCtx.createImageData(160, 100);
      function paint() {
        for (let i = 0; i < tiles.data.length; i += 4) {
          tiles.data[i] = (Math.random() * 256) | 0;
          tiles.data[i + 1] = (Math.random() * 256) | 0;
          tiles.data[i + 2] = (Math.random() * 256) | 0;
          tiles.data[i + 3] = 255;
        }
        sourceCtx.putImageData(tiles, 0, 0);
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        requestAnimationFrame(paint);
      }
      requestAnimationFrame(paint);`,
};

const PAGE = (variant: FixtureVariant) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WebMCP frame fixture</title>
    <style>
      body { margin: 0; font: 16px/1.4 system-ui, sans-serif; }
      .band { height: 220px; display: flex; align-items: center;
              justify-content: center; font-size: 48px; color: #fff; }
      #clock { position: fixed; top: 0; left: 0; padding: 8px 12px;
               background: #000; color: #0f0; font-family: monospace;
               font-size: 28px; z-index: 10; }
    </style>
  </head>
  <body>
    <!-- What paints here depends on the variant: a counter on every animation
         frame (so the measured rate is the throttle's rather than a page that
         stopped changing), one paint and then silence, or a mosaic heavy
         enough to make a slow consumer feel it. -->
    <div id="clock">0</div>
    <canvas id="noise" style="position:fixed;inset:0;z-index:1"
            ${variant === "busy" ? "" : "hidden"}></canvas>
    <div id="bands"></div>
    <script>
      const colors = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400",
                      "#16a085", "#2c3e50", "#7f8c8d"];
      const bands = document.getElementById("bands");
      for (let i = 0; i < 40; i += 1) {
        const band = document.createElement("div");
        band.className = "band";
        band.style.background = colors[i % colors.length];
        band.textContent = "band " + i;
        bands.appendChild(band);
      }
      ${BODY[variant]}

      // The registration itself is not what this suite measures, but a session
      // only starts when the page API is present, so the fixture has to be a
      // real WebMCP page rather than a blank one.
      const context = document.modelContext ?? navigator.modelContext;
      context?.registerTool?.({
        name: "scroll_report",
        description: "Reports how far the fixture page has been scrolled.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return {
            content: [{ type: "text", text: "scrollY=" + window.scrollY }],
          };
        },
      });
    </script>
  </body>
</html>`;

export interface FixturePage {
  url: string;
  close: () => Promise<void>;
}

export async function startWebMcpFixturePage(
  options: { variant?: FixtureVariant } = {},
): Promise<FixturePage> {
  const variant = options.variant ?? "animated";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(PAGE(variant));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
