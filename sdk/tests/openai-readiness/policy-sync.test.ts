/**
 * The OpenAI corpus sync's two OpenAI-specific pieces: reading the manifest
 * without importing it, and diffing the publisher's own page index.
 *
 * The index diff exists because a per-page hash is blind to exactly one
 * failure, and it is the failure most likely to happen: every pinned page
 * byte-identical while a requirement landed on a page nobody pinned. A corpus
 * that cannot notice that is a corpus that grades against yesterday's policy
 * and reports no drift.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — a maintenance script, deliberately plain JS with no types.
import {
  diffIndexAgainstCorpus,
  parseLlmsIndex,
  readManifestSource,
} from "../../../scripts/sync-openai-policy-manifest.mjs";
// @ts-expect-error — as above.
import {
  readConstArray,
  readPageUrlPairs,
} from "../../../scripts/lib/policy-manifest-sync.mjs";

import { OPENAI_PLUGINS_POLICY_PAGES } from "../../src/openai-readiness/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_SOURCE = readFileSync(
  join(here, "../../src/openai-readiness/manifest.ts"),
  "utf8",
);

const BASE = "https://developers.openai.com/plugins";

const parse = (body: string, base = BASE): Set<string> =>
  parseLlmsIndex(body, base) as Set<string>;

const diff = (
  index: Set<string>,
  pinned: readonly string[],
): { drifted: boolean; message: string } =>
  diffIndexAgainstCorpus(index, pinned) as {
    drifted: boolean;
    message: string;
  };

describe("reading the manifest without importing it", () => {
  it("recovers the base URL and both page lists from the TS source", () => {
    const { baseUrl, plugins, external } = readManifestSource(
      MANIFEST_SOURCE,
    ) as {
      baseUrl: string;
      plugins: string[];
      external: { page: string; url: string }[];
    };

    // The script must agree with the module about the corpus; a regex that
    // silently matched nothing would sync an empty page set and report success.
    expect(baseUrl).toBe(BASE);
    expect(plugins).toEqual([...OPENAI_PLUGINS_POLICY_PAGES]);
    expect(external.length).toBeGreaterThan(0);
    for (const entry of external) {
      expect(entry.url.startsWith("https://")).toBe(true);
    }
  });

  it("returns undefined for an array the source does not declare", () => {
    expect(readConstArray(MANIFEST_SOURCE, "NO_SUCH_ARRAY")).toBeUndefined();
    expect(readPageUrlPairs(MANIFEST_SOURCE, "NO_SUCH_PAIRS")).toBeUndefined();
  });
});

describe("parseLlmsIndex", () => {
  it("reads slugs out of markdown link targets", () => {
    expect(
      parse(
        [
          "# Plugins",
          "- [Quickstart](https://developers.openai.com/plugins/quickstart.md): start here",
          "- [Package your plugin](https://developers.openai.com/plugins/build/plugins.md)",
        ].join("\n"),
      ),
    ).toEqual(new Set(["quickstart", "build/plugins"]));
  });

  it("treats a root-relative path and an absolute URL as the same page", () => {
    expect(
      parse("[a](/plugins/build/skills.md) [b](/plugins/build/skills)"),
    ).toEqual(new Set(["build/skills"]));
  });

  it("ignores links to other products on the same host", () => {
    // The index links out to the Apps SDK and the commerce specs. Pulling
    // those in would pin pages belonging to a different product's policy and
    // then report perpetual drift against a corpus we never meant to grade.
    expect(
      parse(
        [
          "[plugins](https://developers.openai.com/plugins/reference.md)",
          "[apps](https://developers.openai.com/apps-sdk/reference.md)",
          "[commerce](https://developers.openai.com/commerce/specs/checkout.md)",
        ].join("\n"),
      ),
    ).toEqual(new Set(["reference"]));
  });

  it("drops fragments and trailing slashes", () => {
    expect(
      parse("[a](/plugins/app-guidelines/) [b](/plugins/reference#tools)"),
    ).toEqual(new Set(["app-guidelines", "reference"]));
  });

  it("ignores the index's own combined export, which is not a page", () => {
    // `llms.txt` links `llms-full.txt` alongside the pages it indexes. Read as
    // a slug it becomes one the corpus can never pin — the fetch would ask for
    // `llms-full.txt.md` and get a 404 — so the drift check would report an
    // added page every week with no way to reconcile it, which is precisely
    // how a maintainer learns to stop reading this alarm.
    expect(
      parse(
        [
          "[full](https://developers.openai.com/plugins/llms-full.txt)",
          "[page](https://developers.openai.com/plugins/reference.md)",
        ].join("\n"),
      ),
    ).toEqual(new Set(["reference"]));
  });

  it("treats the base as a path SEGMENT, not a string prefix", () => {
    // `plugins-legacy` starts with `plugins`. Slicing on the bare prefix turns
    // it into the slug `-legacy/x`: a page that cannot be pinned and is
    // therefore permanent drift.
    expect(
      parse(
        [
          "[legacy](https://developers.openai.com/plugins-legacy/reference.md)",
          "[real](https://developers.openai.com/plugins/reference.md)",
        ].join("\n"),
      ),
    ).toEqual(new Set(["reference"]));
  });

  it("reads a relative link as the same page as an absolute one", () => {
    // `./build/skills.md` and `/plugins/build/skills.md` are one page. Leaving
    // the `./` on makes them two, and the second is drift that never resolves.
    expect(parse("[a](./build/skills.md) [b](/plugins/build/skills.md)")).toEqual(
      new Set(["build/skills"]),
    );
  });

  it("does not mistake the index's own title for a page", () => {
    expect(parse("# Plugins\n\nSome prose with no links.")).toEqual(new Set());
  });

  it("strips a fragment BEFORE the .md extension, not after", () => {
    // Order is what makes this correct, and getting it wrong manufactures
    // drift out of nothing: `$` does not match mid-string, so stripping `.md`
    // first leaves `skills.md#importing` untouched and the slug settles at
    // `build/skills.md` — a page the corpus does not pin and the diff duly
    // reports as newly added upstream.
    expect(parse("[a](/plugins/build/skills.md#importing-from-mcp)")).toEqual(
      new Set(["build/skills"]),
    );
  });

  it("strips a query string the same way", () => {
    expect(parse("[a](/plugins/app-guidelines.md?v=2)")).toEqual(
      new Set(["app-guidelines"]),
    );
  });

  it("matches the plugins prefix as a whole segment", () => {
    // An unanchored prefix strip turns `plugins-guide/x` into `-guide/x`,
    // which is not a page on either side of the comparison.
    expect(parse("[a](/plugins-guide/nope.md)")).toEqual(
      new Set(["plugins-guide/nope"]),
    );
  });
});

describe("an empty extraction is a FAILED one", () => {
  // `[]` is truthy, so a caller writing `if (!pages) throw` accepts it, syncs a
  // corpus of nothing, records no drift and exits 0 — a green check that
  // verified zero pages. That is the exact failure the whole sync exists to
  // prevent, arrived at by a different door than the one already guarded.
  it("returns undefined for an array literal holding no strings", () => {
    expect(readConstArray("const PAGES = [] as const;", "PAGES")).toBe(
      undefined,
    );
  });

  it("returns undefined for a page/url list holding no pairs", () => {
    expect(readPageUrlPairs("const EXTERNAL = [] as const;", "EXTERNAL")).toBe(
      undefined,
    );
  });

  it("makes the OpenAI manifest reader throw rather than sync nothing", () => {
    expect(() =>
      readManifestSource(
        [
          'const OPENAI_PLUGINS_DOCS_BASE_URL = "https://x.example.com";',
          "const OPENAI_PLUGINS_POLICY_PAGES = [] as const;",
          "const OPENAI_EXTERNAL_POLICY_PAGES = [] as const;",
        ].join("\n"),
      ),
    ).toThrow(/Could not read/);
  });
});

describe("diffIndexAgainstCorpus", () => {
  const pinned = ["quickstart", "build/plugins", "deploy/submission"];

  it("reports no drift when the index matches the pinned set", () => {
    const result = diff(new Set(pinned), pinned);
    expect(result.drifted).toBe(false);
    expect(result.message).toContain("the same set");
  });

  it("detects a page added upstream that the corpus does not pin", () => {
    // This is the case a per-page hash is blind to: nothing we pinned moved,
    // and there is now a requirement page nobody cites.
    const result = diff(
      new Set([...pinned, "deploy/submission-errors"]),
      pinned,
    );
    expect(result.drifted).toBe(true);
    expect(result.message).toContain("deploy/submission-errors");
    expect(result.message).toContain("does not pin");
  });

  it("detects a pinned page the index no longer lists", () => {
    // A synthetic removal: the corpus still cites `build/plugins`, upstream no
    // longer publishes it, and every remaining hash is unchanged. Findings
    // citing the removed page are now pointing at nothing.
    const result = diff(
      new Set(pinned.filter((slug) => slug !== "build/plugins")),
      pinned,
    );
    expect(result.drifted).toBe(true);
    expect(result.message).toContain("build/plugins");
    expect(result.message).toContain("no longer listed upstream");
  });

  it("reports an addition and a removal together", () => {
    const result = diff(new Set(["quickstart", "reference"]), pinned);
    expect(result.drifted).toBe(true);
    expect(result.message).toContain("reference");
    expect(result.message).toContain("build/plugins");
    expect(result.message).toContain("deploy/submission");
  });
});
