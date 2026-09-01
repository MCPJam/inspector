import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { resolve } from "path";
import { assertWsNativeFallback } from "./src/ws-native-fallback.assert";
import { electronBuildSurface } from "./shared/sentry-config";

const enableMacSigning = process.platform === "darwin";
const macSignIdentity = process.env.MAC_CODESIGN_IDENTITY?.trim();

if (enableMacSigning && !macSignIdentity) {
  // eslint-disable-next-line no-console
  console.warn(
    "[forge] MAC_CODESIGN_IDENTITY not set - macOS build will use default signing (no identity configured). Set MAC_CODESIGN_IDENTITY for distributable builds.",
  );
}

const osxSignOptions =
  enableMacSigning && macSignIdentity
    ? {
        identity: macSignIdentity,
        "hardened-runtime": true,
        entitlements: resolve(__dirname, "assets", "entitlements.mac.plist"),
        "entitlements-inherit": resolve(
          __dirname,
          "assets",
          "entitlements.mac.plist",
        ),
        "gatekeeper-assess": false,
      }
    : undefined;

const osxNotarizeOptions =
  enableMacSigning && macSignIdentity
    ? process.env.APPLE_API_KEY_ID &&
      process.env.APPLE_API_ISSUER_ID &&
      process.env.APPLE_API_KEY_FILE
      ? {
          // For notarytool auth with ASC API key
          // appleApiKey: path to the .p8 file
          // appleApiKeyId: the key ID (e.g., QN5YX8VT8S)
          // appleApiIssuer: the issuer ID (GUID)
          appleApiKey: process.env.APPLE_API_KEY_FILE,
          appleApiKeyId: process.env.APPLE_API_KEY_ID,
          appleApiIssuer: process.env.APPLE_API_ISSUER_ID,
        }
      : process.env.APPLE_ID &&
          process.env.APPLE_APP_SPECIFIC_PASSWORD &&
          process.env.APPLE_TEAM_ID
        ? {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          }
        : undefined
    : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // Unpack native modules so they can be properly signed
      // This prevents the "different Team IDs" error on macOS
      unpack: "*.node",
    },
    appBundleId: "com.mcpjam.inspector",
    appCategoryType: "public.app-category.developer-tools",
    executableName: "mcpjam-inspector",
    // Writes CFBundleURLTypes into the macOS Info.plist so LaunchServices
    // knows the bundle owns mcpjam://. macOS only routes a scheme to a
    // bundle that declares it, and the plist can't be modified at runtime:
    // the app.setAsDefaultProtocolClient("mcpjam") call in src/main.ts
    // registers the scheme on Windows (via the registry), while Linux
    // resolves the handler from the installed .desktop entry. Without this
    // declaration the browser leg of desktop sign-in has nowhere to hand
    // the OAuth callback back to.
    protocols: [
      {
        name: "MCPJam Inspector",
        schemes: ["mcpjam"],
      },
    ],
    icon: "assets/icon",
    extraResource: [
      resolve(__dirname, "dist", "client"),
      resolve(__dirname, ".env.production"),
      resolve(__dirname, "..", "sdk", "dist"),
    ],
    osxSign: osxSignOptions,
    osxNotarize: osxNotarizeOptions,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "mcpjam-inspector",
      setupExe: "MCPJam-Inspector-Setup.exe",
      // Use generated Windows icon if present
      setupIcon: resolve(__dirname, "assets", "icon.ico"),
      // Signing params read from env on Windows CI
      // Example (set in CI):
      // WINDOWS_PFX_FILE, WINDOWS_PFX_PASSWORD
      signWithParams: (() => {
        const onWindows = process.platform === "win32";
        const pfx = process.env.WINDOWS_PFX_FILE;
        const pwd = process.env.WINDOWS_PFX_PASSWORD;
        if (!onWindows || !pfx || !pwd) return undefined; // build unsigned when secrets are absent
        return `/f \"${pfx}\" /p \"${pwd}\" /tr http://timestamp.digicert.com /td sha256 /fd sha256`;
      })(),
    }),
    new MakerZIP({}, ["darwin", "linux"]),
    new MakerDMG({
      format: "ULFO",
      name: "MCPJam Inspector",
      overwrite: true,
      additionalDMGOptions: {
        window: {
          size: {
            width: 540,
            height: 380,
          },
        },
      },
    }),
    new MakerDeb({
      options: {
        maintainer: "MCPJam",
        homepage: "https://mcpjam.com",
        description:
          "MCPJam Inspector - Explore and interact with Model Context Protocol servers",
        categories: ["Development"],
      },
    }),
    new MakerRpm({
      options: {
        homepage: "https://mcpjam.com",
        description:
          "MCPJam Inspector - Explore and interact with Model Context Protocol servers",
        categories: ["Development"],
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],

  hooks: {
    /**
     * Inject Sentry debug ids into the Electron bundles and upload their maps.
     *
     * This has to live here, not in the release workflows. `.vite/build` and
     * `.vite/renderer` are produced by @electron-forge/plugin-vite DURING
     * `electron:make` — they do not exist when `npm run build` finishes, so a
     * workflow step between build and make finds nothing to inject and
     * silently no-ops. `packageAfterCopy` is the first hook that runs with the
     * built bundles present, on the copied app tree, before asar packing —
     * so what gets injected is exactly what ships.
     *
     * `dist/client` (the UI the packaged app actually serves from the embedded
     * server) is handled by the workflow instead: it IS built by `npm run
     * build`, and uploading it there keeps this hook to the forge-only outputs.
     *
     * The sourcemap half never throws — a Sentry outage must not fail a signed
     * release. `assertWsNativeFallback` deliberately DOES: it guards a
     * defect that only exists after bundling, and a build that ships it is
     * worse than a build that fails.
     */
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const { execFileSync } = await import("node:child_process");
      const { existsSync, rmSync, readdirSync, statSync, readFileSync } =
        await import("node:fs");
      const fsBits = { existsSync, rmSync, readdirSync, statSync };

      // Before anything best-effort: refuse to pack a main bundle whose `ws`
      // would reach for the empty optional-peer-dep stub. Runs on every
      // package/make, costs a grep over already-built output.
      assertWsNativeFallback(resolve(buildPath, ".vite/build"), {
        existsSync,
        readdirSync,
        statSync,
        readFileSync,
      });

      // Release name must match what the SDKs init with: `app.getVersion()`
      // in main, `__APP_VERSION__` in the renderer — both package.json. Same
      // for `--dist` below: `electronBuildSurface(process.platform)` is what
      // main reports (src/main.ts) and what vite.renderer.config.mts stamps
      // into the renderer, so all three agree by construction.
      const targets: Array<[string, string]> = [
        [resolve(buildPath, ".vite/build"), "inspector-electron"],
        [resolve(buildPath, ".vite/renderer"), "inspector-client"],
      ];

      // Cleanup is NOT conditional on the token. A tokenless build still
      // emits the maps; returning early here would pack them into the asar,
      // which is the leak this hook exists to prevent. No upload, but no maps
      // in the installer either.
      if (!process.env.SENTRY_AUTH_TOKEN) {
        console.warn(
          "[forge] SENTRY_AUTH_TOKEN unset; dropping maps without upload",
        );
        for (const [dir] of targets) deleteMapsIn(dir, fsBits);
        return;
      }

      const version = String(
        JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"))
          .version,
      );

      // On Windows `npx` resolves to `npx.cmd`, and since Node's
      // CVE-2024-27980 hardening spawning a `.cmd` with `shell: false` throws
      // EINVAL — which the catch below would swallow, silently killing
      // Windows symbolication. With a shell, args have to be quoted by hand.
      // `timeout` bounds a best-effort upload: a hung sentry-cli must not
      // stall a signed release.
      const isWindows = process.platform === "win32";
      const quote = (arg: string) =>
        isWindows && /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
      const run = (args: string[]) =>
        execFileSync("npx", args.map(quote), {
          stdio: "inherit",
          shell: isWindows,
          timeout: 5 * 60_000,
        });

      for (const [dir, project] of targets) {
        if (!existsSync(dir)) {
          console.warn(`[forge] ${dir} absent; skipping sourcemaps`);
          continue;
        }
        try {
          const cli = ["@sentry/cli", "sourcemaps"];
          run([...cli, "inject", dir]);
          run([
            ...cli,
            "upload",
            `--release=${version}`,
            `--dist=${electronBuildSurface(process.platform)}`,
            "--org=mcpjam-gh",
            `--project=${project}`,
            dir,
          ]);
        } catch (error) {
          console.warn(`[forge] sourcemap upload failed for ${dir}`, error);
        } finally {
          // Always drop the maps, even if the upload failed — the injected JS
          // is what ships, and loose maps in the installer are a leak.
          deleteMapsIn(dir, fsBits);
        }
      }
    },
  },
};

type FsBits = {
  existsSync: (p: string) => boolean;
  rmSync: (p: string) => void;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory: () => boolean };
};

/** Recursively remove `*.map` files under `dir`. Never throws. */
function deleteMapsIn(dir: string, fs: FsBits): void {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        deleteMapsIn(full, fs);
      } else if (entry.endsWith(".map")) {
        fs.rmSync(full);
      }
    }
  } catch {
    // Best effort.
  }
}

export default config;
