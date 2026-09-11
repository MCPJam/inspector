import { describe, expect, it } from "vitest";
import { readTabMetadata } from "../tab-metadata";
import type { CdpLike } from "../webmcp-bridge";

function fakeCdp(replies: Record<string, unknown | (() => unknown)>): CdpLike {
  return {
    async send(method) {
      const reply = replies[method];
      if (reply === undefined) throw new Error(`no reply for ${method}`);
      return typeof reply === "function" ? (reply as () => unknown)() : reply;
    },
    on() {},
  };
}

const history = (
  currentIndex: number,
  entries: Array<{ url: string; title?: string }>,
) => ({
  "Page.getNavigationHistory": { currentIndex, entries },
});

const icon = (href: string) => ({
  "Runtime.evaluate": { result: { value: href } },
});

describe("readTabMetadata", () => {
  it("reads the current entry's url and title", async () => {
    const cdp = fakeCdp({
      ...history(1, [
        { url: "https://a.test/", title: "A" },
        { url: "https://b.test/", title: "B" },
      ]),
      ...icon("https://b.test/favicon.svg"),
    });
    await expect(readTabMetadata(cdp, "https://stale.test/")).resolves.toEqual({
      url: "https://b.test/",
      title: "B",
      faviconUrl: "https://b.test/favicon.svg",
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("says a fresh tab can go neither way", async () => {
    // Chromium counts the current document as an entry, so a one-entry history
    // is a tab that has been nowhere.
    const cdp = fakeCdp({
      ...history(0, [{ url: "https://a.test/", title: "A" }]),
      ...icon(""),
    });
    const meta = await readTabMetadata(cdp, "https://a.test/");
    expect(meta.canGoBack).toBe(false);
    expect(meta.canGoForward).toBe(false);
  });

  it("says a tab that went back can go forward", async () => {
    const cdp = fakeCdp({
      ...history(0, [{ url: "https://a.test/" }, { url: "https://b.test/" }]),
      ...icon(""),
    });
    const meta = await readTabMetadata(cdp, "https://a.test/");
    expect(meta.canGoBack).toBe(false);
    expect(meta.canGoForward).toBe(true);
  });

  it("reports an empty title rather than substituting the url", async () => {
    // The strip decides what to draw for a title-less tab. Baking the fallback
    // in here would make "the page titled itself with its hostname" and "the
    // page has no title yet" indistinguishable.
    const cdp = fakeCdp({
      ...history(0, [{ url: "https://a.test/" }]),
      ...icon(""),
    });
    expect((await readTabMetadata(cdp, "https://a.test/")).title).toBe("");
  });

  it("keeps only favicon schemes a renderer will paint", async () => {
    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "about:blank",
    ]) {
      const cdp = fakeCdp({
        ...history(0, [{ url: "https://a.test/" }]),
        ...icon(href),
      });
      expect(
        (await readTabMetadata(cdp, "https://a.test/")).faviconUrl,
      ).toBeUndefined();
    }
    const cdp = fakeCdp({
      ...history(0, [{ url: "https://a.test/" }]),
      ...icon("data:image/png;base64,iVBORw0KGgo="),
    });
    expect((await readTabMetadata(cdp, "https://a.test/")).faviconUrl).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("drops an absurdly long favicon rather than carrying it", async () => {
    const cdp = fakeCdp({
      ...history(0, [{ url: "https://a.test/" }]),
      ...icon(`data:image/png;base64,${"A".repeat(4000)}`),
    });
    expect(
      (await readTabMetadata(cdp, "https://a.test/")).faviconUrl,
    ).toBeUndefined();
  });

  it("truncates a title a page set to a novel", async () => {
    const cdp = fakeCdp({
      ...history(0, [{ url: "https://a.test/", title: "x".repeat(1000) }]),
      ...icon(""),
    });
    expect((await readTabMetadata(cdp, "https://a.test/")).title).toHaveLength(
      256,
    );
  });

  it("falls back to the driver's url when CDP cannot answer", async () => {
    // A tab that closed between the list being taken and this being asked is
    // the ordinary case, not a fault.
    const cdp = fakeCdp({
      "Page.getNavigationHistory": () => {
        throw new Error("No target with given id found");
      },
      "Runtime.evaluate": () => {
        throw new Error("No target with given id found");
      },
    });
    await expect(readTabMetadata(cdp, "https://known.test/")).resolves.toEqual({
      url: "https://known.test/",
      title: "",
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("survives a page with no CDP session at all", async () => {
    await expect(readTabMetadata(null, "https://known.test/")).resolves.toEqual(
      {
        url: "https://known.test/",
        title: "",
        canGoBack: false,
        canGoForward: false,
      },
    );
  });

  it("skips the favicon evaluate when the caller does not want one", async () => {
    let evaluated = false;
    const cdp: CdpLike = {
      async send(method) {
        if (method === "Runtime.evaluate") {
          evaluated = true;
          return { result: { value: "" } };
        }
        return { currentIndex: 0, entries: [{ url: "https://a.test/" }] };
      },
      on() {},
    };
    await readTabMetadata(cdp, "https://a.test/", { favicon: false });
    expect(evaluated).toBe(false);
  });

  it("treats a malformed history reply as unreadable", async () => {
    const cdp = fakeCdp({
      "Page.getNavigationHistory": { entries: "not an array" },
      ...icon(""),
    });
    const meta = await readTabMetadata(cdp, "https://a.test/");
    expect(meta.url).toBe("https://a.test/");
    expect(meta.canGoBack).toBe(false);
  });
});
