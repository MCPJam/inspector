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
    asar: true,
    appBundleId: "com.mcpjam.inspector",
    appCategoryType: "public.app-category.developer-tools",
    executableName: "mcpjam-inspector",
    icon: "assets/icon",
    extraResource: [
      resolve(__dirname, "dist", "client"),
      resolve(__dirname, ".env.production"),
      resolve(__dirname, "sdk", "dist"),
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
};

export default config;
