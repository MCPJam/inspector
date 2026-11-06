/**
 * The share card's faces, for the browser. The card is an SVG shown and saved
 * as an image, and an image cannot fetch fonts, so each face is inlined as a
 * data URL. The server inlines the same `@fontsource` files for the og:image.
 */

import montserrat600 from "@fontsource/montserrat/files/montserrat-latin-600-normal.woff2?url";
import montserrat800 from "@fontsource/montserrat/files/montserrat-latin-800-normal.woff2?url";
import instrumentSans600 from "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2?url";
import jetbrainsMono400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import {
  SHARE_CARD_FONT_FACES,
  shareCardFontFaceCss,
} from "@/shared/conformance-share-card";

/** Each face's bundled URL, keyed by its file in `SHARE_CARD_FONT_FACES`. */
export const SHARE_CARD_FONT_URLS: Record<string, string> = {
  "@fontsource/montserrat/files/montserrat-latin-600-normal.woff2":
    montserrat600,
  "@fontsource/montserrat/files/montserrat-latin-800-normal.woff2":
    montserrat800,
  "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2":
    instrumentSans600,
  "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2":
    jetbrainsMono400,
};

let fontFaceCssPromise: Promise<string> | null = null;

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The card's `@font-face` rules with every face inlined. Loaded once. */
export function loadShareCardFontFaceCss(): Promise<string> {
  fontFaceCssPromise ??= Promise.all(
    SHARE_CARD_FONT_FACES.map(async ({ file }) => {
      const url = SHARE_CARD_FONT_URLS[file];
      // Internal: the preview falls back to the browser's own faces.
      if (!url) throw new Error(`No bundled URL for ${file}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load a card font.");
      return [file, await toDataUrl(await response.blob())] as const;
    }),
  )
    .then((entries) => {
      const inlined = new Map<string, string>(entries);
      return shareCardFontFaceCss((file) => inlined.get(file) ?? "");
    })
    .catch((error: unknown) => {
      // A failed load must not stick: the next dialog tries again.
      fontFaceCssPromise = null;
      throw error;
    });
  return fontFaceCssPromise;
}
