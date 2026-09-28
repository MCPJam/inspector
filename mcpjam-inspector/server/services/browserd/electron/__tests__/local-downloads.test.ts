import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dialog = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
vi.mock("electron", () => ({
  dialog,
  BrowserWindow: {
    getAllWindows: () => [{ isVisible: () => true, isDestroyed: () => false }],
  },
}));
vi.mock("../../../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));
import {
  installLocalDownloads,
  LOCAL_DOWNLOAD_MAX_BYTES,
} from "../local-downloads";
import { createLocalBrowserSecurityPolicy } from "../../local/security-policy";
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
function fixture(url = "https://example.test/file") {
  const session = new EventEmitter(),
    contents = new EventEmitter();
  let active = true;
  const revoked = new Set<() => void | Promise<void>>();
  const policy = createLocalBrowserSecurityPolicy({
    isActive: () => active,
    assertActive: async () => {
      if (!active) throw new Error("revoked");
    },
    onRevoked: (callback) => {
      revoked.add(callback);
      return () => revoked.delete(callback);
    },
  });
  const item = Object.assign(new EventEmitter(), {
    path: "",
    total: 12,
    received: 12,
    getURL: () => url,
    getURLChain: () => [url],
    getFilename: () => "../../untrusted.txt",
    getTotalBytes() {
      return this.total;
    },
    getReceivedBytes() {
      return this.received;
    },
    setSavePath(path: string) {
      this.path = path;
    },
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(() => item.emit("done", {}, "cancelled")),
  });
  const stop = installLocalDownloads(session as never, () => policy);
  return {
    item,
    start: () => session.emit("will-download", {}, item, contents),
    close: () => {
      stop();
      policy.dispose?.();
    },
    revoke: async () => {
      active = false;
      await Promise.all([...revoked].map((cb) => cb()));
    },
  };
}
describe("local human-approved downloads", () => {
  it.each([
    "https://example.test/authenticated-post",
    "blob:https://example.test/download",
  ])(
    "saves the original %s download only after native approval",
    async (url) => {
      const dir = await mkdtemp(join(tmpdir(), "download-test-"));
      directories.push(dir);
      const destination = join(dir, "chosen.txt");
      let approve!: (value: unknown) => void;
      dialog.showSaveDialog.mockImplementation(
        () =>
          new Promise((resolve) => {
            approve = resolve;
          }),
      );
      const f = fixture(url);
      f.start();
      await vi.waitFor(() =>
        expect(dialog.showSaveDialog).toHaveBeenCalledOnce(),
      );
      expect(f.item.pause).toHaveBeenCalledOnce();
      expect(f.item.resume).not.toHaveBeenCalled();
      approve({ canceled: false, filePath: destination });
      await vi.waitFor(() => expect(f.item.resume).toHaveBeenCalledOnce());
      await writeFile(f.item.path, "original download");
      f.item.emit("done", {}, "completed");
      await vi.waitFor(async () =>
        expect(await readFile(destination, "utf8")).toBe("original download"),
      );
      f.close();
    },
  );
  it("denies a second download and cancels pending native approval on revocation", async () => {
    let approve!: (value: unknown) => void;
    dialog.showSaveDialog.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const first = fixture(),
      second = fixture();
    first.start();
    await vi.waitFor(() =>
      expect(dialog.showSaveDialog).toHaveBeenCalledOnce(),
    );
    second.start();
    expect(second.item.cancel).toHaveBeenCalled();
    await first.revoke();
    expect(first.item.cancel).toHaveBeenCalled();
    approve({ canceled: false, filePath: "/never-written" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(first.item.resume).not.toHaveBeenCalled();
    first.close();
    second.close();
  });
  it("cancels unknown-size downloads when the received bytes exceed the cap", async () => {
    dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(tmpdir(), "not-published"),
    });
    const f = fixture();
    f.item.total = 0;
    f.start();
    await vi.waitFor(() => expect(f.item.resume).toHaveBeenCalled());
    f.item.received = LOCAL_DOWNLOAD_MAX_BYTES + 1;
    f.item.emit("updated");
    expect(f.item.cancel).toHaveBeenCalled();
    f.close();
  });
});
