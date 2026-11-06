/**
 * The share card's faces, for the browser. The preview names them in a
 * scoped @font-face block; "Download PNG" inlines them as data URLs, because
 * html-to-image draws through an SVG image that cannot fetch fonts itself.
 * The server loads the same faces (as WOFF, for satori) from the same
 * packages, so all three drawings use one set of files.
 */

import montserrat600 from "@fontsource/montserrat/files/montserrat-latin-600-normal.woff2?url";
import montserrat800 from "@fontsource/montserrat/files/montserrat-latin-800-normal.woff2?url";
import instrumentSans500 from "@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff2?url";
import instrumentSans600 from "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2?url";
import jetbrainsMono400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import jetbrainsMono500 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url";
import { SHARE_CARD_FONTS } from "@/shared/conformance-share-card";

const FACES = [
  { family: SHARE_CARD_FONTS.display, weight: 600, url: montserrat600 },
  { family: SHARE_CARD_FONTS.display, weight: 800, url: montserrat800 },
  { family: SHARE_CARD_FONTS.sans, weight: 500, url: instrumentSans500 },
  { family: SHARE_CARD_FONTS.sans, weight: 600, url: instrumentSans600 },
  { family: SHARE_CARD_FONTS.mono, weight: 400, url: jetbrainsMono400 },
  { family: SHARE_CARD_FONTS.mono, weight: 500, url: jetbrainsMono500 },
] as const;

function fontFaceCss(srcFor: (url: string) => string): string {
  return FACES.map(
    ({ family, weight, url }) =>
      `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(${srcFor(url)}) format("woff2");}`,
  ).join("\n");
}

/** @font-face rules pointing at the bundled files, for the live preview. */
export const SHARE_CARD_FONT_FACE_CSS = fontFaceCss((url) =>
  JSON.stringify(url),
);

/** Resolves once every face the card uses is ready to draw. */
export async function loadShareCardFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all(
    FACES.map(({ family, weight }) =>
      document.fonts.load(`${weight} 16px "${family}"`).catch(() => []),
    ),
  );
}

let embedCssPromise: Promise<string> | null = null;

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The same rules with each file inlined, for html-to-image's export. */
export function shareCardFontEmbedCss(): Promise<string> {
  embedCssPromise ??= Promise.all(
    FACES.map(async ({ url }) => {
      const response = await fetch(url);
      // Internal: caught by the download, which shows its own message.
      if (!response.ok) {
        throw new Error("Could not load a card font. Try again.");
      }
      return [url, await toDataUrl(await response.blob())] as const;
    }),
  )
    .then((entries) => {
      const inlined = new Map(entries);
      return fontFaceCss((url) => JSON.stringify(inlined.get(url) ?? url));
    })
    .catch((error: unknown) => {
      embedCssPromise = null;
      throw error;
    });
  return embedCssPromise;
}
