import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { openContext } from "../lib/inspector-driver-browser.mjs";

const GUEST_PATH = "/api/web/guest-session";

/** A fixture origin that counts guest mints and answers each with its count. */
async function fixtureOrigin(name, mint) {
  const counts = { POST: 0, GET: 0 };
  const server = createServer((request, response) => {
    if (request.url !== GUEST_PATH) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>fixture</title>");
      return;
    }
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    mint(request, response, `${name}-${counts[request.method]}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    counts,
    close: () => server.close(),
  };
}

const answer = (request, response, body) => {
  response.writeHead(200, {
    "content-type": "text/plain",
    "access-control-allow-origin": "*",
  });
  response.end(body);
};

let app;
let other;
let redirecting;

before(async () => {
  app = await fixtureOrigin("app", answer);
  other = await fixtureOrigin("other", answer);
  redirecting = await fixtureOrigin("redirecting", (request, response) => {
    response.writeHead(307, { location: `${other.origin}${GUEST_PATH}` });
    response.end();
  });
});

after(() => {
  for (const fixture of [app, other, redirecting]) fixture?.close();
});

async function contextFor(t, baseUrl) {
  const session = await openContext({ baseUrl, fresh: true });
  t.after(() => session.close());
  return session.context;
}

async function mintTwice(context, origin, method = "POST") {
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  const bodies = await page.evaluate(
    async ({ path, method }) => {
      const out = [];
      for (let i = 0; i < 2; i += 1) {
        out.push(await (await fetch(path, { method })).text());
      }
      return out;
    },
    { path: GUEST_PATH, method },
  );
  await page.close();
  return bodies;
}

test("the guest mint is replayed on the app's origin only", async (t) => {
  const context = await contextFor(t, app.origin);
  assert.deepEqual(await mintTwice(context, app.origin), [
    "app-1",
    "app-1",
  ]);
  assert.equal(app.counts.POST, 1);

  // Another origin with the same path never receives the app's guest.
  assert.deepEqual(await mintTwice(context, other.origin), [
    "other-1",
    "other-2",
  ]);
  assert.equal(other.counts.POST, 2);

  // Only the mint itself is replayed, not other methods on its path.
  assert.deepEqual(await mintTwice(context, app.origin, "GET"), [
    "app-1",
    "app-2",
  ]);
  assert.equal(app.counts.GET, 2);
});

test("a mint that redirects is never cached for replay", async (t) => {
  const context = await contextFor(t, redirecting.origin);
  await mintTwice(context, redirecting.origin);
  assert.equal(redirecting.counts.POST, 2);
});
