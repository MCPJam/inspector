/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISABLE_POSTHOG_LOCAL: string;
  readonly VITE_DOCKER?: string;
  readonly VITE_RUNTIME?: string;
  readonly VITE_MCPJAM_HOSTED_MODE?: string;
  readonly VITE_MCPJAM_SANDBOX_ORIGIN?: string;
  readonly VITE_MCPJAM_VIEW_MOUNT?: string;
  readonly VITE_MCPJAM_VIEW_SUBDOMAINS?: string;
  readonly VITE_ENVIRONMENT?: string;
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
/** Sentry `dist` — which build emitted this bundle. See `SENTRY_BUILD_SURFACES`. */
declare const __BUILD_SURFACE__: import("../../shared/sentry-config").SentryBuildSurface;
