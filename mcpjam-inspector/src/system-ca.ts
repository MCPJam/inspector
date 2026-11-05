import tls from "node:tls";

type TlsCaApi = Pick<
  typeof tls,
  "getCACertificates" | "setDefaultCACertificates"
>;

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * Make Node trust the operating system's certificate store, alongside the
 * roots it bundles.
 *
 * The window is Chromium, which already trusts the OS store; the embedded
 * server is Node, which by default trusts only its bundled roots. On a network
 * that re-signs HTTPS with a company root, every request the server makes then
 * fails with SELF_SIGNED_CERT_IN_CHAIN or UNABLE_TO_GET_ISSUER_CERT_LOCALLY,
 * and a first launch never gets its guest session: the app sits on the
 * loading screen. `--use-system-ca` would do the same, but the NodeOptions fuse
 * is off and a Finder or Start-menu launch never sees shell variables, so it
 * has to happen here, before the server makes its first request.
 *
 * The same fuse makes a packaged build ignore `NODE_EXTRA_CA_CERTS`, so the OS
 * store is the only way a company root reaches the server there. An unfused
 * development build still reads that variable into the default list.
 */
export function trustSystemCertificates(
  log: Logger,
  api: Partial<TlsCaApi> = tls,
): boolean {
  if (
    typeof api.getCACertificates !== "function" ||
    typeof api.setDefaultCACertificates !== "function"
  ) {
    log.warn(
      "[tls] this runtime cannot read the system certificate store; using Node's bundled roots only",
    );
    return false;
  }
  try {
    const system = api.getCACertificates("system");
    api.setDefaultCACertificates([
      ...new Set([...api.getCACertificates("default"), ...system]),
    ]);
    log.info(
      `[tls] trusting ${system.length} system certificate(s) alongside Node's bundled roots`,
    );
    return true;
  } catch (error) {
    log.warn(
      "[tls] could not load the system certificate store; using Node's bundled roots only",
      error,
    );
    return false;
  }
}
