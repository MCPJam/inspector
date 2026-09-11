/**
 * The pages a browser agent is actually asked to deal with, served locally.
 *
 * Every capability the daemon grew — refs, occlusion, dialogs, network — was
 * built against a fake CDP session, which proves the daemon does what it was
 * told and nothing about whether a real Chromium agrees. These pages are the
 * other half: one place for the spike lane to point at, and the fixtures an
 * eval comparing interfaces (flat verbs vs a batch vs a script) has to share
 * if its arms are to be comparable at all.
 *
 * SERVED, NOT `data:`. The spike lane's existing fixtures are data URLs, which
 * is fine until something needs a request: a data URL issues none, so it can
 * never exercise the network ring, a 401, or a fetch that fails. A local
 * server also gives every page a real origin, which is what makes an origin
 * allowlist testable.
 *
 * LOCAL, NOT A PUBLIC DEMO, for the reason the e2e fixtures give: a test that
 * fails when someone else's site is down is a test people learn to ignore.
 * The pizza-maker demo is the right SMOKE test and the wrong regression test.
 *
 * Each page is deliberately small and does exactly one awkward thing, because
 * a fixture that exercises four features at once cannot say which one broke.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

const HTML = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:16px system-ui;margin:24px}</style></head>` +
  `<body>${body}</body></html>`;

/**
 * A login form: labelled fields, a `<select>`, and a submit that visibly wins.
 *
 * The single most common thing a browser agent is asked to do, and the one
 * where targeting is measurable: the fields are reachable by ref (their labels
 * are their accessible names), by selector, and by coordinate, so the same
 * task can be driven three ways and compared.
 */
const FORM = HTML(
  "Sign in",
  `<h1>Sign in</h1>
   <form id="f">
     <p><label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="off"></p>
     <p><label for="password">Password</label>
        <input id="password" name="password" type="password"></p>
     <p><label for="plan">Plan</label>
        <select id="plan"><option value="s">Small</option>
          <option value="m">Medium</option><option value="l">Large</option>
        </select></p>
     <p><button id="submit" type="submit">Continue</button></p>
   </form>
   <div id="done" hidden><h2>Signed in</h2><p id="summary"></p></div>
   <script>
     document.getElementById("f").addEventListener("submit", (event) => {
       event.preventDefault();
       document.getElementById("f").hidden = true;
       const done = document.getElementById("done");
       done.hidden = false;
       document.getElementById("summary").textContent =
         document.getElementById("email").value + " on " +
         document.getElementById("plan").value;
     });
   </script>`,
);

/**
 * A button under a consent banner — the occlusion case, and the reason
 * `target_covered` exists.
 *
 * The banner is `position: fixed` over the button's centre, which is exactly
 * how a real one behaves: a coordinate click lands on the banner and reports
 * success, and the page has not changed.
 */
const COVERED = HTML(
  "Covered",
  `<h1>Offers</h1>
   <p><button id="buy" onclick="document.title='bought'">Buy now</button></p>
   <div id="consent" style="position:fixed;left:0;right:0;top:0;height:120px;
        background:#222;color:#fff;padding:16px">
     <span class="cookie-bar">We use cookies</span>
     <button id="accept" onclick="document.getElementById('consent').remove()">
       Accept
     </button>
   </div>`,
);

/**
 * Dialogs, raised the way pages raise them: from a click.
 *
 * `confirm` is the one that matters — it is the dialog whose default answer is
 * being chosen on an absent user's behalf, and the page records what it was
 * told so a test can prove the answer rather than infer it.
 */
const DIALOGS = HTML(
  "Dialogs",
  `<h1>Dialogs</h1>
   <p><button id="warn" onclick="alert('Heads up')">Alert</button></p>
   <p><button id="del" onclick="
        document.getElementById('out').textContent =
          confirm('Delete this account?') ? 'confirmed' : 'cancelled'">
      Delete</button></p>
   <p><button id="ask" onclick="
        document.getElementById('out').textContent =
          'prompt:' + String(prompt('Your name?', 'anon'))">
      Prompt</button></p>
   <p id="out">untouched</p>`,
);

/**
 * A page whose list is empty because a request failed — not because the page
 * is broken in any way it can show you.
 *
 * The whole case for a network mode: the layout is right, the console is
 * silent (the fetch is caught), and the only evidence is a 401 on the wire.
 */
const NETWORK = HTML(
  "Items",
  `<h1>Items</h1>
   <ul id="items"></ul>
   <script>
     fetch("/api/items", { headers: { "x-demo": "1" } })
       .then((r) => (r.ok ? r.json() : []))
       .then((rows) => {
         for (const row of rows) {
           const li = document.createElement("li");
           li.textContent = row;
           document.getElementById("items").appendChild(li);
         }
       })
       .catch(() => {});
   </script>`,
);

/**
 * A page that offers WebMCP tools, for the half of the stack that is about
 * the page's own API rather than its pixels.
 *
 * Registered imperatively, which is the shape Chromium does NOT carry
 * annotations through — so a fixture that relied on `readOnly` being visible
 * would be testing something the browser does not actually provide.
 */
const WEBMCP = HTML(
  "Pizza",
  `<h1>Pizza</h1>
   <p id="toppings">none</p>
   <script>
     if (window.document.modelContext) {
       document.modelContext.registerTool({
         name: "add_topping",
         description: "Add a topping to the pizza",
         inputSchema: {
           type: "object",
           properties: {
             topping: {
               oneOf: [
                 { const: "pepperoni", title: "Pepperoni" },
                 { const: "mushroom", title: "Mushroom" },
               ],
             },
           },
           required: ["topping"],
         },
         async execute({ topping }) {
           const el = document.getElementById("toppings");
           el.textContent = el.textContent === "none" ? topping : el.textContent + ", " + topping;
           return { content: [{ type: "text", text: "Added " + topping }] };
         },
       });
     }
   </script>`,
);

const PAGES: Record<string, string> = {
  "/form": FORM,
  "/covered": COVERED,
  "/dialogs": DIALOGS,
  "/network": NETWORK,
  "/webmcp": WEBMCP,
};

/** The page names this fixture serves, for a test that wants to iterate them. */
export const FIXTURE_PATHS = Object.keys(PAGES);

export interface FixtureServer {
  /** Base URL, e.g. `http://127.0.0.1:53211`. Paths are `FIXTURE_PATHS`. */
  origin: string;
  /** `origin + path`, for readability at the call site. */
  url(path: string): string;
  /** Every request the server saw, so a test can assert what the page asked for. */
  readonly requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

/**
 * Start the fixture server on an ephemeral port.
 *
 * `/api/items` answers 401 deliberately — it is the failure the `/network`
 * page cannot show you and the network ring can.
 */
export async function startBrowserFixtures(): Promise<FixtureServer> {
  const requests: Array<{ method: string; path: string }> = [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push({ method: req.method ?? "GET", path });
    if (path === "/api/items") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const page = PAGES[path];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no such fixture");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: (path: string) => `${origin}${path}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
