import { requestMatch } from "./evidence.mjs";
import {
  installBrowserTrace,
  browserTrace,
  restoreBrowserTrace,
} from "./browser-trace.mjs";
import {
  measurePlaygroundTurn,
  playgroundSubmission,
} from "./playground-clock.mjs";

const composer = "Try a prompt that could call your tools...";

// Each arm owns a fresh normal chat. Never rewrite a stored transcript or lane.
export async function openPlaygroundArm(context, opener, config) {
  const url = new URL(config.url),
    target = new URL(config.chatApiUrl);
  for (const u of [url, target])
    if (
      u.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(u.hostname)
    )
      throw Error("The benchmark only runs on local development servers.");
  if (
    process.env.HARN24_QA_PROJECT_ID !== config.projectId ||
    new URL(opener.url()).origin !== url.origin
  )
    throw Error("Select the signed-in internal qualification project.");
  url.searchParams.delete("conversation");
  const opened = context.waitForEvent("page");
  await opener.evaluate((href) => window.open(href, "_blank"), url.href);
  const page = await opened;
  page.on("request", (request) => {
    const auth = request.headers().authorization;
    if (
      new URL(request.url()).origin === url.origin &&
      auth?.startsWith("Bearer ")
    )
      config.onAuthorization?.(auth);
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/api/web/chat-v2")
      process.stderr.write(
        "Chat request failed: " + request.failure()?.errorText + "\\n",
      );
  });
  let chatId, pending;
  const history = [];
  await page.route("**/api/web/chat-v2", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (!pending) return route.abort();
    try {
      const body = route.request().postDataJSON();
      if (!body.chatSessionId || (chatId && chatId !== body.chatSessionId))
        throw Error("The arm changed chats.");
      pending.matchId = requestMatch(body, config, [
        ...history,
        ["user", pending.prompt],
      ]);
      if (!chatId)
        await config.beforeFirstDispatch?.(
          body.chatSessionId,
          route.request().headers().authorization,
        );
      chatId = body.chatSessionId;
    } catch (error) {
      pending.reject(Object.assign(error, { protocolFailure: true }));
      return route.abort();
    }
    return route.continue({ url: target.href });
  });
  async function prepare() {
    await page.bringToFront();
    await page.getByPlaceholder(composer).waitFor({ timeout: 90_000 });
    await page.getByTestId("client-selector-trigger").click();
    await page.getByTestId("client-row-" + config.hostId).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    for (const server of config.servers) {
      const row = page
        .getByText(server.name, { exact: true })
        .last()
        .locator("../..");
      const connect = row.getByRole("button", { name: "Connect", exact: true });
      if (await connect.count()) await connect.click();
      await row.getByRole("switch").waitFor({ timeout: 30_000 });
    }
    await page.keyboard.press("Escape");
  }
  try {
    await prepare();
  } catch (error) {
    await page.close();
    throw error;
  }
  async function stop() {
    const button = page.getByRole("button", {
      name: "Stop generating",
      exact: true,
    });
    if (await button.count()) await button.click();
  }
  return {
    page,
    get chatId() {
      return chatId;
    },
    history,
    close: () => page.close(),
    async authorization() {
      const value = await page.evaluate(async () => {
        const { getApiAuthorizationHeader } =
          await import("/src/lib/apis/web/context.ts");
        return getApiAuthorizationHeader();
      });
      if (!value?.startsWith("Bearer "))
        throw Error("The QA browser needs a signed-in session.");
      return value;
    },
    stop,
    async send(prompt, workload = "text", toolName, expectedText) {
      await page.bringToFront();
      await installBrowserTrace(page);
      await page.getByPlaceholder(composer).fill(prompt);
      await page.getByPlaceholder(composer).blur();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await page.getByPlaceholder(composer).inputValue() !== prompt)
        throw Error("The composer changed the benchmark prompt before submission.");
      let reject;
      const refused = new Promise((_, r) => {
        reject = r;
      });
      pending = { prompt, reject };
      const observation = pending;
      const response = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/web/chat-v2",
        { timeout: 70_000 },
      );
      let sample, reply;
      try {
        [sample, reply] = await Promise.race([
          Promise.all([
            measurePlaygroundTurn(page, workload, toolName),
            response,
          ]),
          refused,
        ]);
      } catch (error) {
        throw Object.assign(error, {
          submittedAt: await playgroundSubmission(page),
        });
      } finally {
        pending = undefined;
        await restoreBrowserTrace(page);
      }
      if (!observation.matchId)
        throw Error("The arm did not submit a verified request.");
      if (sample.failed) await stop();
      let deadline;
      let finished;
      try {
        finished = await Promise.race([
          reply.finished(),
          new Promise((r) => {
            deadline = setTimeout(
              () => r(Error("Turn completion deadline")),
              sample.failed ? 15_000 : 120_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      if (finished || !reply.ok()) sample.failed = true;
      if (finished) sample.protocolFailure = true;
      const text = page.locator('[data-message-text="assistant"]').last();
      const output = (await text.count())
        ? (await text.innerText({ timeout: 2000 })).trim()
        : "";
      if (expectedText !== undefined && output !== expectedText)
        throw Error("The arm's priming response differs.");
      if (
        await page
          .getByText(/computer.*(replaced|recycled)|session.*reset/i)
          .count()
      )
        sample.failed = true;
      history.push(["user", prompt], ["assistant", output]);
      return {
        ...sample,
        trace: await browserTrace(page),
        matchId: observation.matchId,
        output,
        endedAt: await page.evaluate(
          () => performance.timeOrigin + performance.now(),
        ),
      };
    },
  };
}
