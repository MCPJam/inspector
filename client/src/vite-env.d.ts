/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISABLE_POSTHOG_LOCAL: string;
  readonly VITE_DOCKER?: string;
  readonly VITE_RUNTIME?: string;
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
