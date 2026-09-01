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

const PAGE = `<!doctype html>
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
    <!-- Repaints on every animation frame, so the screencast always has
         something new to send and the measured rate reflects the throttle
         rather than a page that simply stopped changing. -->
    <div id="clock">0</div>
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
      const clock = document.getElementById("clock");
      let ticks = 0;
      function paint() {
        ticks += 1;
        clock.textContent = String(ticks);
        requestAnimationFrame(paint);
      }
      requestAnimationFrame(paint);

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

export async function startWebMcpFixturePage(): Promise<FixturePage> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(PAGE);
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
