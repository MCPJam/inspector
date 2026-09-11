import type { Session } from "electron";
import type { LocalBrowserSecurityPolicy } from "../local/security-policy.js";
import { startLocalBrowserProxy } from "../local/egress-proxy.js";
import {
  cleanAbandonedLocalDownloads,
  installLocalDownloads,
} from "./local-downloads.js";

interface PartitionPolicy {
  policies: Set<LocalBrowserSecurityPolicy>;
  ready: Promise<void>;
  stop: () => Promise<void>;
}
/** Electron permits one webRequest listener per event; this module owns it. */
const installed = new WeakMap<Session, PartitionPolicy>();
export async function installElectronLocalSecurity(
  session: Session,
  policy: LocalBrowserSecurityPolicy,
): Promise<() => void> {
  let entry = installed.get(session);
  if (!entry) {
    const policies = new Set<LocalBrowserSecurityPolicy>([policy]);
    const current = () => [...policies].filter((p) => p.isActive());
    // Install synchronously before starting any asynchronous partition setup.
    session.webRequest.onBeforeRequest((details, callback) => {
      const active = current();
      callback({
        cancel:
          !active.length || !active.every((p) => p.allowsRequest(details.url)),
      });
    });
    const stopDownloads = installLocalDownloads(session, () => current()[0]);
    entry = { policies, ready: Promise.resolve(), stop: async () => {} };
    installed.set(session, entry);
    const own = entry;
    own.ready = (async () => {
      await cleanAbandonedLocalDownloads();
      // The proxy pins the checked DNS answer. A webRequest-only DNS check
      // would let Chromium resolve a different address during rebinding.
      const proxy = await startLocalBrowserProxy(policy);
      const { app } = await import("electron");
      const address = new URL(proxy.proxy.server);
      const login = (
        event: Electron.Event,
        contents: Electron.WebContents | null,
        _details: Electron.AuthenticationResponseDetails,
        auth: Electron.AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => {
        if (
          !auth.isProxy ||
          auth.host !== address.hostname ||
          auth.port !== Number(address.port)
        )
          return;
        event.preventDefault();
        if (current().length && (!contents || contents.session === session))
          callback(proxy.proxy.username, proxy.proxy.password);
        else callback();
      };
      app.on("login", login);
      own.stop = async () => {
        stopDownloads();
        app.removeListener("login", login);
        await proxy.close();
      };
      try {
        await session.closeAllConnections();
        await session.setProxy({
          mode: "fixed_servers",
          proxyRules: proxy.proxy.server,
          proxyBypassRules: "<-loopback>",
        });
        // Old controller responses must never be read offline after upgrading.
        await session.clearCache();
        await session.clearStorageData({
          storages: ["serviceworkers", "cachestorage"],
        });
        await policy.assertActive();
      } catch (error) {
        await own.stop();
        throw error;
      }
    })();
  } else entry.policies.add(policy);
  const own = entry;
  try {
    await own.ready;
  } catch (error) {
    own.policies.delete(policy);
    installed.delete(session);
    throw error;
  }
  return () => {
    own.policies.delete(policy);
    if (!own.policies.size) {
      // Keep the denying network listener; do not restore a direct route.
      installed.delete(session);
      void own.stop();
    }
  };
}
