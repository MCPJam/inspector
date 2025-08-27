/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISABLE_POSTHOG_LOCAL: string;
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
