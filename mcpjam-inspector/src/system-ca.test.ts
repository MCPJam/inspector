import tls from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { trustSystemCertificates } from "./system-ca";

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("trustSystemCertificates", () => {
  it("adds the system store to the default roots, once each", () => {
    const setDefaultCACertificates = vi.fn();
    const api = {
      getCACertificates: vi.fn((type?: string) =>
        type === "system" ? ["CORP_ROOT", "SHARED_ROOT"] : ["BUNDLED_ROOT", "SHARED_ROOT"],
      ),
      setDefaultCACertificates,
    };
    const log = logger();

    expect(trustSystemCertificates(log, api)).toBe(true);
    expect(setDefaultCACertificates).toHaveBeenCalledWith([
      "BUNDLED_ROOT",
      "SHARED_ROOT",
      "CORP_ROOT",
    ]);
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps the bundled roots when the system store cannot be read", () => {
    const setDefaultCACertificates = vi.fn();
    const failure = new Error("keychain unavailable");
    const api = {
      getCACertificates: vi.fn(() => {
        throw failure;
      }),
      setDefaultCACertificates,
    };
    const log = logger();

    expect(trustSystemCertificates(log, api)).toBe(false);
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it("does nothing on a runtime without the certificate APIs", () => {
    const log = logger();
    expect(trustSystemCertificates(log, {})).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  // Early Node 22 releases lack one or both APIs, and the engines range allows them.
  const realApi =
    typeof tls.getCACertificates === "function" &&
    typeof tls.setDefaultCACertificates === "function";

  it.runIf(realApi)("puts the system roots into the default list this Node actually uses", () => {
    // The real API: every later TLS connection without its own `ca`, including
    // the server's `fetch`, verifies against this list.
    const before = tls.getCACertificates("default");
    try {
      expect(trustSystemCertificates(logger())).toBe(true);
      const after = new Set(tls.getCACertificates("default"));
      for (const cert of [...before, ...tls.getCACertificates("system")])
        expect(after.has(cert)).toBe(true);
    } finally {
      tls.setDefaultCACertificates(before);
    }
  });
});
