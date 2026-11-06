/**
 * Draws the conformance share card as a PNG on the server, for the og:image of
 * a shared run's link. satori lays the shared element tree out into an SVG
 * (text becomes paths), and resvg rasterises it. The browser draws the same
 * tree for "Download PNG", so the two images cannot drift apart.
 *
 * resvg is the WebAssembly build: no native binary to ship with the npm
 * package or the desktop app. Both the wasm and the fonts load once, lazily,
 * from their packages in node_modules.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import satori from "satori";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import {
  SHARE_CARD_FONTS,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildConformanceShareCard,
  type ConformanceShareCardData,
} from "@/shared/conformance-share-card";

type SatoriFont = {
  name: string;
  data: Buffer;
  weight: 400 | 500 | 600 | 800;
  style: "normal";
};

const FONT_FILES: Array<{
  name: string;
  weight: SatoriFont["weight"];
  file: string;
}> = [
  {
    name: SHARE_CARD_FONTS.display,
    weight: 600,
    file: "@fontsource/montserrat/files/montserrat-latin-600-normal.woff",
  },
  {
    name: SHARE_CARD_FONTS.display,
    weight: 800,
    file: "@fontsource/montserrat/files/montserrat-latin-800-normal.woff",
  },
  {
    name: SHARE_CARD_FONTS.sans,
    weight: 500,
    file: "@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff",
  },
  {
    name: SHARE_CARD_FONTS.sans,
    weight: 600,
    file: "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff",
  },
  {
    name: SHARE_CARD_FONTS.mono,
    weight: 400,
    file: "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff",
  },
  {
    name: SHARE_CARD_FONTS.mono,
    weight: 500,
    file: "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff",
  },
];

let fontsPromise: Promise<SatoriFont[]> | null = null;
let wasmPromise: Promise<void> | null = null;

function packageFile(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

function loadFonts(): Promise<SatoriFont[]> {
  fontsPromise ??= Promise.all(
    FONT_FILES.map(async ({ name, weight, file }) => ({
      name,
      weight,
      style: "normal" as const,
      data: await readFile(packageFile(file)),
    })),
  ).catch((error) => {
    // A failed load must not stick: the next request tries again.
    fontsPromise = null;
    throw error;
  });
  return fontsPromise;
}

function loadResvg(): Promise<void> {
  wasmPromise ??= readFile(packageFile("@resvg/resvg-wasm/index_bg.wasm"))
    .then((wasm) => initWasm(wasm))
    .catch((error: unknown) => {
      // initWasm throws if a previous call already initialised the module.
      if (
        error instanceof Error &&
        /already initialized/i.test(error.message)
      ) {
        return;
      }
      wasmPromise = null;
      throw error;
    });
  return wasmPromise;
}

export async function renderConformanceShareCardPng(
  data: ConformanceShareCardData,
): Promise<Uint8Array> {
  const [fonts] = await Promise.all([loadFonts(), loadResvg()]);
  const svg = await satori(buildConformanceShareCard(data), {
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    fonts,
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: SHARE_CARD_WIDTH },
  });
  try {
    return resvg.render().asPng();
  } finally {
    resvg.free();
  }
}
