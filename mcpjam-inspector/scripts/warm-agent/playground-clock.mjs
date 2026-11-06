/** Measure Send to first paint in one foreground document.
 * Two animation frames allow a painting opportunity. */
export async function armPlaygroundClock(page, workload, toolName) {
  if (workload === "tool" && !toolName)
    throw Error("A specific fixture tool is required.");
  await page.evaluate(
    ({ workload, toolName }) => {
      if (document.visibilityState !== "visible")
        throw Error("The qualification page must be visible.");
      const button = document.querySelector(
        'button[aria-label="Send message"]',
      );
      if (!button || button.disabled)
        throw Error("The Send button is unavailable.");
      const prior = new Set(
        [...document.querySelectorAll("[data-message-id]")].map(
          (node) => node.dataset.messageId,
        ),
      );
      const selector =
        workload === "text"
          ? '[data-message-text="assistant"]'
          : '[data-tool-name="' +
            CSS.escape(toolName ?? "") +
            '"]:is([data-tool-state="input-streaming"],[data-tool-state="input-available"])';
      const visible = (node) => {
        const bounds = node.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.bottom > 0 &&
          bounds.right > 0 &&
          bounds.top < innerHeight &&
          bounds.left < innerWidth &&
          getComputedStyle(node).visibility === "visible"
        );
      };
      let observer, timeout, frame, resolve, started;
      const clicked = () => {
        started = performance.now();
        timeout = setTimeout(
          () => finish({ failed: true, ms: 60_000 }),
          60_000,
        );
        const qualifying = () =>
          [...document.querySelectorAll(selector)].some((node) => {
            const message = node.closest("[data-message-id]");
            return (
              message &&
              !prior.has(message.dataset.messageId) &&
              visible(node) &&
              (workload !== "text" || node.textContent.trim().length)
            );
          });
        globalThis.__warmAgentClock.ended = () =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (workload === "tool" && !qualifying())
                finish({ failed: true, ms: 60_000 });
            }),
          );
        const inspect = () => {
          if (frame || !qualifying()) return;
          frame = requestAnimationFrame(() => {
            if (!qualifying()) {
              frame = undefined;
              return;
            }
            frame = requestAnimationFrame(() =>
              finish({
                failed: document.visibilityState !== "visible",
                ms: performance.now() - started,
                event:
                  workload === "text" ? "painted-text" : "painted-tool-start",
              }),
            );
          });
        };
        observer = new MutationObserver(inspect);
        observer.observe(document.body, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
        inspect();
      };
      function finish(result) {
        clearTimeout(timeout);
        cancelAnimationFrame(frame);
        observer?.disconnect();
        button.removeEventListener("click", clicked, true);
        resolve({
          ...result,
          submittedAt:
            started === undefined
              ? undefined
              : performance.timeOrigin + started,
        });
      }
      const result = new Promise((r) => {
        resolve = r;
      });
      // A run can be stopped before Send if Playwright loses its page.
      globalThis.__warmAgentClock?.cancel();
      globalThis.__warmAgentClock = {
        result,
        get submittedAt() {
          return started === undefined
            ? undefined
            : performance.timeOrigin + started;
        },
        cancel: () => finish({ failed: true, ms: 60_000 }),
      };
      button.addEventListener("click", clicked, { capture: true, once: true });
    },
    { workload, toolName },
  );
}

export async function playgroundSubmission(page) {
  try {
    return await page.evaluate(() => globalThis.__warmAgentClock?.submittedAt);
  } catch {
    // A destroyed document has no usable timestamp; that invalidates the sample.
    return undefined;
  }
}

export async function measurePlaygroundTurn(page, workload, toolName) {
  await armPlaygroundClock(page, workload, toolName);
  try {
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click({ timeout: 5000 });
    return await page.evaluate(() => globalThis.__warmAgentClock.result);
  } finally {
    // A failed navigation may already have discarded the observer's document.
    if (!page.isClosed())
      await page.evaluate(() => globalThis.__warmAgentClock?.cancel());
  }
}
