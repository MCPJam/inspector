import tls from "node:tls";
import type { ConnectionOptions } from "node:tls";

// The SDK also supports Node 20, before getCACertificates was introduced.
const certificateStore = tls as typeof tls & {
  getCACertificates?: (type: "default" | "system") => string[];
};

/** Local inspectors should trust the CAs installed by the machine's owner. */
export function localTlsOptions(
  url: URL,
  useSystemCa: boolean,
): Pick<ConnectionOptions, "ca"> {
  if (
    url.protocol !== "https:" ||
    !useSystemCa ||
    typeof certificateStore.getCACertificates !== "function"
  ) {
    return {};
  }

  // An explicit `ca` replaces Node's defaults, so retain those (including
  // NODE_EXTRA_CA_CERTS) as well as the OS store. Verification stays enabled.
  return {
    ca: [
      ...new Set([
        ...certificateStore.getCACertificates("default"),
        ...certificateStore.getCACertificates("system"),
      ]),
    ],
  };
}
