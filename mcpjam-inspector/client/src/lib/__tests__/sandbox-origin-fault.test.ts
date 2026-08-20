/**
 * The boot guard reports a hosted deploy that never configured a sandbox
 * origin — once per tab, because the fault is a property of the deploy and
 * capturing per page view buries the signal under its own volume.
 *
 * It no longer reports an origin that merely EQUALS the app's own. That
 * condition is true both of a deploy that pointed its sandbox at itself and of
 * the app being loaded on the sandbox hostname, and no page can tell those
 * apart — which is how a crawler walking our DNS names paged us
 * (INSPECTOR-CLIENT-247). That check lives on the server now.
 */
import { describe, expect, it } from "vitest";
import { detectSandboxOriginFault } from "../sandbox-origin-fault";

/** A real key/value store, so "once per tab" is exercised rather than asserted. */
function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("detectSandboxOriginFault", () => {
  it("captures the first time a tab sees an unset origin, and never again", () => {
    const getStorage = (() => {
      const storage = fakeStorage();
      return () => storage;
    })();

    const first = detectSandboxOriginFault({
      hostedMode: true,
      sandboxOrigin: null,
      getStorage,
    });
    const second = detectSandboxOriginFault({
      hostedMode: true,
      sandboxOrigin: null,
      getStorage,
    });

    expect(first?.shouldCapture).toBe(true);
    expect(second?.shouldCapture).toBe(false);
    // The console line is unconditional, so the message survives either way.
    expect(second?.message).toBe(first?.message);
    expect(first?.message).toContain("VITE_MCPJAM_SANDBOX_ORIGIN");
  });

  it("stays silent when a distinct origin is configured", () => {
    expect(
      detectSandboxOriginFault({
        hostedMode: true,
        sandboxOrigin: "https://sandbox.mcpjam.test",
        getStorage: fakeStorage,
      })
    ).toBeNull();
  });

  it("stays silent when the configured origin equals the app's own", () => {
    expect(
      detectSandboxOriginFault({
        hostedMode: true,
        sandboxOrigin: "https://app.mcpjam.test",
        getStorage: fakeStorage,
      })
    ).toBeNull();
  });

  it("stays silent outside hosted mode", () => {
    expect(
      detectSandboxOriginFault({
        hostedMode: false,
        sandboxOrigin: null,
        getStorage: fakeStorage,
      })
    ).toBeNull();
  });

  it("keeps reporting when sessionStorage throws — noisy beats silent", () => {
    const getStorage = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };

    for (const _ of [1, 2]) {
      expect(
        detectSandboxOriginFault({
          hostedMode: true,
          sandboxOrigin: null,
          getStorage,
        })?.shouldCapture
      ).toBe(true);
    }
  });

  it("keeps reporting when the store itself rejects a write", () => {
    const getStorage = () => ({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
    });

    expect(
      detectSandboxOriginFault({
        hostedMode: true,
        sandboxOrigin: null,
        getStorage,
      })?.shouldCapture
    ).toBe(true);
  });
});
