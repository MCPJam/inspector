/**
 * The share card on screen and as a file. The card is one SVG
 * (`buildConformanceShareCardSvg`): the dialog shows it as an image, and
 * "Download PNG" draws that same image onto a canvas at twice its size. No
 * library: the browser does both.
 */

import { useEffect, useMemo, useState } from "react";
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildConformanceShareCardSvg,
  shareCardAltText,
  type ConformanceShareCardData,
} from "@/shared/conformance-share-card";
import { loadShareCardFontFaceCss } from "./share-card-fonts";

/** The card's SVG once its fonts are inlined; null until then. */
export function useShareCardSvg(
  data: ConformanceShareCardData | null,
): string | null {
  const [fontFaceCss, setFontFaceCss] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadShareCardFontFaceCss()
      // Without its fonts the card still draws, in the browser's own faces.
      .catch(() => "")
      .then((css) => {
        if (active) setFontFaceCss(css);
      });
    return () => {
      active = false;
    };
  }, []);

  return useMemo(
    () =>
      data && fontFaceCss !== null
        ? buildConformanceShareCardSvg(data, { fontFaceCss })
        : null,
    [data, fontFaceCss],
  );
}

export function ShareCardPreview({
  data,
  svg,
}: {
  data: ConformanceShareCardData;
  svg: string | null;
}) {
  const src = useMemo(
    () =>
      svg
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        : null,
    [svg],
  );

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg bg-black shadow-sm ring-1 ring-black/10"
      style={{ aspectRatio: `${SHARE_CARD_WIDTH} / ${SHARE_CARD_HEIGHT}` }}
      data-testid="conformance-share-card"
    >
      {src ? (
        <img
          src={src}
          alt={shareCardAltText(data)}
          className="block size-full"
          draggable={false}
        />
      ) : (
        <div
          className="size-full animate-pulse bg-muted"
          role="status"
          aria-label="Loading the score card"
        />
      )}
    </div>
  );
}

/** The card as a PNG at twice its size (2400 × 1260), drawn from its SVG. */
export async function exportShareCardPng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_CARD_WIDTH * 2;
    canvas.height = SHARE_CARD_HEIGHT * 2;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas to draw the card on");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("The canvas gave no PNG")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
