import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsCredential } from "../../../../shared/credential-urls";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "../..");
const repoRoot = join(clientSrc, "../../..");

/**
 * Sentry Replay records stylesheet text — a `<style>` element's text, an
 * inlined stylesheet, CSSOM rule changes — exactly as the page holds it, and
 * offers no option that masks it or hook that edits it (see "Known gaps" in
 * docs/session-replay-masking.md). So the app never writes a credential URL
 * into CSS: every CSS `url(` in app source is a fragment reference
 * (`url(#gradient)`), a literal that holds no credential, or one of the
 * dynamic sites below, each with the reason its value is not stylesheet text
 * carrying a credential. A new `url(${…})` fails here until it is reviewed.
 */
const DYNAMIC_URL_SITES = new Map<string, string>([
  [
    "mcpjam-inspector/client/src/components/host-workspace/ExtensionIcon.tsx",
    "An extension's own SVG icon, drawn as an inline `style` mask, never " +
      "stylesheet text. Sentry blocks any element whose `style` has `url(` " +
      "(SENTRY_UNMASKABLE_URL_ELEMENTS); PostHog's `before_send` scrubs " +
      "`style` attributes in replay batches.",
  ],
]);

const SOURCE_ROOTS = [clientSrc, join(repoRoot, "chat-ui/src")];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules"
        ? []
        : sourceFiles(path);
    }
    return /\.(?:tsx?|css)$/.test(entry.name) &&
      !/\.(?:test|spec|stories)\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

interface CssUrl {
  file: string;
  /** The text between `url(` and the first `)` or line end. */
  argument: string;
}

/**
 * Every CSS `url(` in a file. In TypeScript only the lowercase spelling
 * counts (`new URL(` is not CSS); `.url(` and `toUrl(` are not CSS either.
 */
function cssUrls(file: string): CssUrl[] {
  const text = readFileSync(file, "utf8");
  const pattern = file.endsWith(".css")
    ? /(?<![\w$.])url\(([^)\n]*)/gi
    : /(?<![\w$.])url\(([^)\n]*)/g;
  return [...text.matchAll(pattern)].map((match) => ({
    file: relative(repoRoot, file),
    argument: (match[1] ?? "").trim().replace(/^["'`]/, ""),
  }));
}

const found = SOURCE_ROOTS.flatMap(sourceFiles).flatMap(cssUrls);

describe("no app stylesheet carries a credential URL", () => {
  it("finds the CSS url() sites it is meant to police", () => {
    expect(found.some((site) => site.argument.startsWith("#"))).toBe(true);
    expect(found.some((site) => site.file.endsWith(".css"))).toBe(true);
    for (const file of DYNAMIC_URL_SITES.keys()) {
      expect(
        found.some((site) => site.file === file),
        `${file} no longer builds a CSS url(); drop it from DYNAMIC_URL_SITES`,
      ).toBe(true);
    }
  });

  it("builds every url() from a fragment, a clean literal, or a reviewed site", () => {
    for (const site of found) {
      if (site.argument.startsWith("#")) continue;
      if (site.argument.includes("${")) {
        expect(
          DYNAMIC_URL_SITES.has(site.file),
          `${site.file} builds a CSS url() from a runtime value. Sentry Replay ` +
            "records stylesheet text unmasked: make sure the value can never " +
            "be a credential URL (shared/credential-urls.ts), then add the " +
            "file to DYNAMIC_URL_SITES with the reason.",
        ).toBe(true);
        continue;
      }
      expect(
        containsCredential(site.argument),
        `${site.file}: url(${site.argument}) holds a credential URL`,
      ).toBe(false);
    }
  });
});
