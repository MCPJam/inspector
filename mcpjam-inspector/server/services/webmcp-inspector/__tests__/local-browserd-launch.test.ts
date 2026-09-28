/**
 * What the WebMCP Inspector's LOCAL Chromium is actually launched with.
 *
 * Two live bugs sat here, both invisible from the running app:
 *
 *  1. The provider passed `extraArgs: buildWebMcpLaunchArgs()` — which carries
 *     `--enable-features=WebMCP` — alongside args that already carry it. Extra
 *     args are appended LAST, and by `daemon/launch-args.ts`'s own rule
 *     Chromium honours the last `--enable-features` and discards every earlier
 *     one. So the Inspector's browser got WebMCP and lost
 *     `CDPScreenshotNewSurface`, quietly moving every capture back to the
 *     legacy screenshot surface.
 *  2. It never passed `surface: "local"`, so a browser on a developer's laptop
 *     took the hosted sandbox's pins: `--disable-gpu` and
 *     `--use-angle=swiftshader-webgl`, which make `WEBGL_debug_renderer_info`
 *     report SwiftShader on a machine that plainly has a GPU — the oldest
 *     headless heuristic there is — and no UA correction, so a headless run
 *     announced `HeadlessChrome` to sites that block it.
 *
 * Neither changes anything you can see until a site quietly behaves
 * differently, which is why this asserts the LAUNCH rather than the outcome.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BROWSERD_SOFTWARE_GL_ARGS,
  buildBrowserdLaunchArgs,
} from "../../browserd/daemon/launch-args";

/** Every `--enable-features` switch in a built arg list. */
const enableSwitches = (args: readonly string[]) =>
  args.filter((arg) => arg.startsWith("--enable-features="));

const featuresIn = (args: readonly string[]) =>
  enableSwitches(args)[0]!.slice("--enable-features=".length).split(",");

describe("the local inspector Chromium's launch args", () => {
  it("carry exactly one --enable-features, with CDPScreenshotNewSurface intact", () => {
    const args = buildBrowserdLaunchArgs([], { surface: "local" });
    expect(enableSwitches(args)).toHaveLength(1);
    expect(featuresIn(args)).toContain("CDPScreenshotNewSurface");
    expect(featuresIn(args)).toContain("WebMCP");
  });

  it("keep both even when a caller passes the WebMCP flag a second time", () => {
    // The shape of the bug, reproduced: this is what the provider used to do.
    // Before the fold, the second switch replaced the first and the screenshot
    // feature was gone.
    const args = buildBrowserdLaunchArgs(["--enable-features=WebMCP"], {
      surface: "local",
    });
    expect(enableSwitches(args)).toHaveLength(1);
    expect(featuresIn(args)).toContain("CDPScreenshotNewSurface");
    expect(featuresIn(args)).toContain("WebMCP");
  });

  it("do NOT carry the hosted sandbox's software-GL pins", () => {
    const args = buildBrowserdLaunchArgs([], { surface: "local" });
    for (const pin of BROWSERD_SOFTWARE_GL_ARGS) {
      expect(args, "a laptop has a real GPU").not.toContain(pin);
    }
  });

  it("still carry them on the sandbox, which genuinely has no GPU", () => {
    const args = buildBrowserdLaunchArgs([], { surface: "sandbox" });
    for (const pin of BROWSERD_SOFTWARE_GL_ARGS) expect(args).toContain(pin);
  });
});

describe("the provider's launch options", () => {
  it("ask for the local surface and add no feature switch of their own", async () => {
    // Asserted at the CALL rather than through a real browser: the whole
    // failure was a pair of options, and a test that needed Chromium would be
    // skipped on every machine that did not have one.
    const launchBrowserdContext = vi.fn(
      async (_options: { surface?: string; extraArgs?: readonly string[] }) => {
        throw new Error("stop here — the options are what this test is about");
      },
    );
    vi.doMock("../../browserd/daemon/chromium-launch", () => ({
      launchBrowserdContext,
      // The module's other exports, as the provider imports them.
      BROWSERD_OBSERVATION_VIEWPORT: { width: 1024, height: 768 },
    }));
    vi.doMock("../../browserd/electron/electron-context", () => ({
      launchElectronContext: vi.fn(),
    }));

    const { localBrowserdWebMcpProvider } = await import(
      "../local-browserd-provider"
    );
    await localBrowserdWebMcpProvider
      .createSession({
        url: "https://example.test/",
        viewportMode: "embedded",
        callbacks: {
          onToolsChanged() {},
          onNavigated() {},
          onPopupOpened() {},
          onExternalInvocation() {},
          onActivityObserved() {},
          onCrashed() {},
          onFrame() {},
        },
      })
      .catch(() => {});

    expect(launchBrowserdContext).toHaveBeenCalledTimes(1);
    const options = launchBrowserdContext.mock.calls[0]![0];
    expect(options.surface).toBe("local");
    // Not merely "no WebMCP flag": passing NOTHING is the honest fix, because
    // everything `buildWebMcpLaunchArgs` carries is already in the shared args.
    expect(options.extraArgs).toBeUndefined();

    vi.doUnmock("../../browserd/daemon/chromium-launch");
    vi.doUnmock("../../browserd/electron/electron-context");
    vi.resetModules();
  });
});
