// Inspector-owned launcher: forces every listener the bridge opens onto
// loopback, then runs the adapter's verbatim bridge.mjs. The bridge itself
// stays byte-identical to the pinned adapter's copy (the provider compares it).
import net from "node:net";
const LOOPBACK = "127.0.0.1";
const wild = (h) => h === undefined || h === null || h === "" || h === "0.0.0.0" || h === "::";
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  if (args.length > 0 && typeof args[0] === "object" && args[0] !== null && !("fd" in args[0]) && !("path" in args[0])) {
    if (wild(args[0].host)) args[0] = { ...args[0], host: LOOPBACK };
  } else if (typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]))) {
    if (typeof args[1] === "string") { if (wild(args[1])) args[1] = LOOPBACK; }
    else args.splice(1, 0, LOOPBACK);
  }
  return origListen.apply(this, args);
};
await import("./bridge.mjs");
