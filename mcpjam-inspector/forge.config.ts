import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { resolve, join, dirname } from "path";
import { cpSync, existsSync, mkdirSync } from "fs";
import * as asar from "@electron/asar";

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
    icon: "assets/icon",
    extraResource: [
      resolve(__dirname, "dist", "client"),
      resolve(__dirname, ".env.production"),
      resolve(__dirname, "..", "sdk", "dist"),
    ],
    osxSign: osxSignOptions,
    osxNotarize: osxNotarizeOptions,
    // Copy @ngrok native module into .vite/build/node_modules before signing.
    // The VitePlugin only packs .vite/build/ into the asar (no top-level node_modules),
    // so the module must live alongside main.cjs for require('@ngrok/ngrok') to resolve.
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        // Resolve @ngrok scope dir via require.resolve so npm workspace hoisting is handled
        let ngrokSrc: string;
        try {
          const ngrokPkg = require.resolve("@ngrok/ngrok/package.json", {
            paths: [__dirname],
          });
          ngrokSrc = dirname(dirname(ngrokPkg)); // …/@ngrok/ngrok/package.json -> …/@ngrok
        } catch {
          ngrokSrc = resolve(__dirname, "node_modules", "@ngrok");
        }
        if (!existsSync(ngrokSrc)) {
          console.warn("[forge] @ngrok not found, skipping copy");
          callback();
          return;
        }
        const dest = join(buildPath, ".vite", "build", "node_modules", "@ngrok");
        mkdirSync(dest, { recursive: true });

        // Copy only the JS wrapper and the platform-matched native package to avoid
        // bundling redundant fat/universal binaries (~19MB saved on arm64-only builds).
        const platformPkg = `ngrok-${_platform}-${_arch}`;
        const pkgsToCopy = ["ngrok", platformPkg];
        for (const pkg of pkgsToCopy) {
          const src = join(ngrokSrc, pkg);
          if (existsSync(src)) {
            console.log(`[forge] Copying @ngrok/${pkg} to ${dest}`);
            cpSync(src, join(dest, pkg), { recursive: true });
          }
        }
        callback();
      },
    ],
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
  hooks: {
    // The asar.unpack pattern only applies to files present at the start of packaging;
    // files added by afterCopy arrive too late to be marked as unpack in the asar header.
    // This hook rebuilds the asar after packaging, promoting *.node files to app.asar.unpacked
    // so Electron can dlopen them (native addons cannot be loaded from inside an asar body).
    postPackage: async (_config, { outputPaths }) => {
      const os = await import("os");
      const { readdirSync } = await import("fs");
      for (const outputPath of outputPaths) {
        // outputPaths is the outer directory (e.g. out/App-darwin-arm64/);
        // find the .app bundle inside it
        let appPath = outputPath;
        if (!outputPath.endsWith(".app")) {
          const entries = readdirSync(outputPath);
          const appBundle = entries.find((e) => e.endsWith(".app"));
          if (!appBundle) continue;
          appPath = join(outputPath, appBundle);
        }
        const resourcesPath = join(appPath, "Contents", "Resources");
        const asarPath = join(resourcesPath, "app.asar");
        if (!existsSync(asarPath)) continue;

        const tmpDir = join(os.tmpdir(), `asar-rebuild-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
        console.log(`[forge] Rebuilding asar to unpack *.node: ${asarPath}`);

        await asar.extractAll(asarPath, tmpDir);
        const { renameSync, unlinkSync } = await import("fs");
        renameSync(asarPath, `${asarPath}.bak`);

        // @electron/asar calls minimatch(absPath, pattern, { matchBase: true }) so
        // patterns without a "/" match on basename only — "*.node" is correct here.
        await asar.createPackageWithOptions(tmpDir, asarPath, {
          unpack: "*.node",
        });

        unlinkSync(`${asarPath}.bak`);
        const { rmSync } = await import("fs");
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  },
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
};

export default config;
