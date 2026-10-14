/** Build-owned metadata only: callers never supply event/debug payloads here. */
export interface SentryBuildMetadata {
  frameOutputNames?: Readonly<Record<string, string>>;
  frameDebugIds?: Readonly<Record<string, string>>;
  platform?: "javascript" | "node";
  dist?: string;
}

const DEBUG_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUILD_SURFACES = [
  "web",
  "npm",
  "desktop-mac",
  "desktop-win",
  "electron-mac",
  "electron-win",
  "local",
];

/** Read only the build tool's injected marker, never an event's debug metadata. */
export function sentryInjectedDebugId(code: string): string | undefined {
  const id =
    /_sentryDebugIdIdentifier\s*=\s*["']sentry-dbid-([0-9a-f-]{36})["']/.exec(
      code
    )?.[1] ?? /(?:^|\n)\/\/# debugId=([0-9a-f-]{36})\s*$/.exec(code)?.[1];
  return id && DEBUG_ID.test(id) ? id : undefined;
}

export function sentryProtocolMetadata(
  files: readonly string[],
  options: SentryBuildMetadata
) {
  const images = [...new Set(files)].flatMap((file) => {
    const debugId = options.frameDebugIds?.[file];
    return debugId && DEBUG_ID.test(debugId)
      ? [{ type: "sourcemap", code_file: file, debug_id: debugId }]
      : [];
  });
  return {
    ...(options.platform === "javascript" || options.platform === "node"
      ? { platform: options.platform }
      : {}),
    ...(options.dist && BUILD_SURFACES.includes(options.dist)
      ? { dist: options.dist }
      : {}),
    ...(images.length ? { debug_meta: { images } } : {}),
  };
}
