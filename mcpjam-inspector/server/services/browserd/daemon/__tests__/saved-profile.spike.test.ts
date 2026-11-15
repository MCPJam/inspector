import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { exportBrowserProfileArchive } from "../../profile-archive";
import { launchBrowserdContext } from "../chromium-launch";
import { prepareBrowserProfile } from "../prepare-browser-profile";

// Opt in with the repository's existing real-browser test switch.
describe.skipIf(process.env.RUN_BROWSERD_SPIKE !== "true")(
  "saved profile in a real ephemeral browser",
  () => {
    it("starts signed in and discards each run's changes", async () => {
      const root = await mkdtemp(join(tmpdir(), "browserd-saved-profile-"));
      const server = createServer((req, res) => {
        if (req.url === "/login")
          res.setHeader("Set-Cookie", "session=seed; Path=/; Max-Age=3600");
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<body><p id="state"></p><button id="mutate" onclick="localStorage.setItem('note', 'changed');document.cookie='session=changed; Path=/';">Change</button><script>document.querySelector('#state').textContent = '${req.headers.cookie ?? ""}' + '; note=' + localStorage.getItem('note')</script></body>`,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Test server has no port");
      const origin = `http://127.0.0.1:${address.port}`;
      try {
        const sourceDir = join(root, "source");
        const source = await chromium.launchPersistentContext(sourceDir, {
          headless: true,
          channel: "chromium",
        });
        try {
          const page = await source.newPage();
          await page.goto(`${origin}/login`);
          await page.evaluate(() => localStorage.setItem("note", "original"));
        } finally {
          await source.close();
        }
        const archive = await exportBrowserProfileArchive(sourceDir);
        for (const iteration of [1, 2]) {
          const archivePath = join(root, `run-${iteration}.tar.gz`);
          const userDataDir = join(root, `run-${iteration}`);
          await writeFile(archivePath, archive);
          const profileImported = await prepareBrowserProfile({
            profileArchivePath: archivePath,
            userDataDir,
          });
          const context = await launchBrowserdContext({
            userDataDir,
            profileImported,
            contextMode: "ephemeral",
            headless: true,
            channel: "chromium",
            deviceScaleFactor: 2,
          });
          try {
            const page = await context.newPage();
            await page.goto(origin);
            expect(await page.pageText()).toContain(
              "session=seed; note=original",
            );
            await page.clickSelector("#mutate");
            await page.reload();
            expect(await page.pageText()).toContain(
              "session=changed; note=changed",
            );
          } finally {
            await context.close();
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
