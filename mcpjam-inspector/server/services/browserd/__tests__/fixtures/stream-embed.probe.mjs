// Reference driver for the M0 stream-embed probes (#2, #3, #4, #10). It uses the
// @e2b/desktop VNC helpers, which the inspector does not depend on — so it is a
// standalone script, NOT imported by the vitest suite (that would force a new
// dependency). Run it by hand when re-validating the stream/embed decisions:
//
//   npm i @e2b/desktop        # in a scratch dir
//   E2B_API_KEY=... node stream-embed.probe.mjs
//
// Findings recorded 2026-08-28 (see ../../SPIKE_FINDINGS.md):
//   #4  the noVNC page returns NO X-Frame-Options and NO CSP → iframe-embeddable.
//  #10  getUrl({viewOnly:true}) sets ?view_only=true (input disabled).
//   #2  the authKey is random per start() and lives only in this process's
//       memory → a fresh replica must read a cached URL+password off the row.
//   #3  a second stream.start() throws "Stream is already running".
import { Sandbox as Desktop } from "@e2b/desktop";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY required");

const box = await Desktop.create({ apiKey, timeoutMs: 5 * 60 * 1000 });
try {
  await box.stream.start({ requireAuth: true });
  const authKey = box.stream.getAuthKey();
  const url = box.stream.getUrl({ authKey });
  const viewOnly = box.stream.getUrl({ authKey, viewOnly: true });

  const res = await fetch(url, { redirect: "manual" });
  console.log(JSON.stringify({
    probe: "stream-embed",
    xFrameOptions: res.headers.get("x-frame-options"), // expect null (#4)
    csp: res.headers.get("content-security-policy"), // expect null (#4)
    viewOnlyDiffers: url !== viewOnly && viewOnly.includes("view_only=true"), // #10
    authKeyLen: authKey.length,
  }, null, 2));

  let secondStart = "no guard";
  try {
    await box.stream.start({ requireAuth: true });
  } catch (e) {
    secondStart = String(e).slice(0, 80); // expect "Stream is already running" (#3)
  }
  console.log("secondStart:", secondStart);
} finally {
  await box.kill().catch(() => {});
}
