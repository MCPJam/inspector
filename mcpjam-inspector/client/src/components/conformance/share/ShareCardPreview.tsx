/**
 * The share card on screen: the 1200 × 630 tree from
 * `@/shared/conformance-share-card`, scaled to the width it is given.
 * `exportShareCardPng` saves the unscaled node, so the download is the card
 * at full size whatever the dialog's width.
 */

import { forwardRef, useLayoutEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildConformanceShareCard,
  type ConformanceShareCardData,
} from "@/shared/conformance-share-card";
import {
  SHARE_CARD_FONT_FACE_CSS,
  loadShareCardFonts,
  shareCardFontEmbedCss,
} from "./share-card-fonts";

export const ShareCardPreview = forwardRef<
  HTMLDivElement,
  { data: ConformanceShareCardData }
>(function ShareCardPreview({ data }, cardRef) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const fit = () => setScale(frame.clientWidth / SHARE_CARD_WIDTH);
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      className="relative w-full overflow-hidden rounded-lg bg-black shadow-sm ring-1 ring-black/10"
      style={{ aspectRatio: `${SHARE_CARD_WIDTH} / ${SHARE_CARD_HEIGHT}` }}
      role="img"
      aria-label="Conformance score card"
      data-testid="conformance-share-card"
    >
      <style>{SHARE_CARD_FONT_FACE_CSS}</style>
      <div
        ref={cardRef}
        aria-hidden
        className="absolute top-0 left-0"
        style={{
          width: SHARE_CARD_WIDTH,
          height: SHARE_CARD_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        {buildConformanceShareCard(data)}
      </div>
    </div>
  );
});

/** The card at full size (2x for sharp text), as a PNG data URL. */
export async function exportShareCardPng(node: HTMLElement): Promise<string> {
  await loadShareCardFonts();
  const fontEmbedCSS = await shareCardFontEmbedCss();
  return toPng(node, {
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    pixelRatio: 2,
    fontEmbedCSS,
    style: { transform: "none" },
  });
}
