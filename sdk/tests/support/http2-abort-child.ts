/**
 * Child process for `http1-fetch.test.ts`. Sends one request; with `abort`,
 * then sends a second one aborted in the same tick it starts and stays alive
 * past undici's four-second HTTP/2 idle reaper. On Node 26's HTTP/2 path that
 * reaping is what crashes the process (nodejs/undici#6143), so the parent
 * asserts this process exits 0.
 *
 * usage: node --import tsx http2-abort-child.ts <url> <plain|http1Fetch|installed> <once|abort>
 */
import {
  http1Fetch,
  installHttp1GlobalDispatcher,
} from "../../src/http1-fetch.js";

const [url, mode, step] = process.argv.slice(2);
if (mode === "installed") installHttp1GlobalDispatcher();
const fetchFn = mode === "http1Fetch" ? http1Fetch : globalThis.fetch;

await (await fetchFn(url)).text();

if (step === "abort") {
  const controller = new AbortController();
  const aborted = fetchFn(url, { signal: controller.signal });
  controller.abort();
  await aborted.then(
    (response) => response.body?.cancel(),
    (error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 5_500));
}

process.exit(0);
