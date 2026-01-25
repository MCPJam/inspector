/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISABLE_POSTHOG_LOCAL: string;
  readonly VITE_DOCKER?: string;
  readonly VITE_RUNTIME?: string;
  readonly VITE_MCPJAM_HOSTED_MODE?: string;
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
