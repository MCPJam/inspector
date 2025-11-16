import { useRef, useLayoutEffect, useState } from "react";

type Coords = { x: number; y: number };

export function useTextareaCaretPosition(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  value: string,
  caretIndex: number,
): Coords {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<Coords>({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const container = containerRef.current;
    if (!textarea || !container) return;

    const safeIndex = Math.max(0, Math.min(value.length, caretIndex));

    // Create mirror once
    if (!mirrorRef.current) {
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.top = "0";
      div.style.left = "0";
      div.style.visibility = "hidden";
      div.style.pointerEvents = "none";
      div.style.whiteSpace = "pre-wrap";
      div.style.overflowWrap = "break-word";
      mirrorRef.current = div;
      document.body.appendChild(div);
    }

    const mirror = mirrorRef.current;

    // Copy relevant text layout styles
    const cs = window.getComputedStyle(textarea);
    mirror.style.fontFamily = cs.fontFamily;
    mirror.style.fontSize = cs.fontSize;
    mirror.style.fontWeight = cs.fontWeight;
    mirror.style.fontStyle = cs.fontStyle;
    mirror.style.letterSpacing = cs.letterSpacing;
    mirror.style.textTransform = cs.textTransform;
    mirror.style.padding = cs.padding;
    mirror.style.borderWidth = cs.borderWidth;
    mirror.style.boxSizing = cs.boxSizing;
    mirror.style.lineHeight = cs.lineHeight;

    // Mirror width of textarea content area
    mirror.style.width = `${textarea.clientWidth}px`;

    // Build content with caret marker
    const before = value.slice(0, safeIndex);
    const after = value.slice(safeIndex);

    mirror.innerHTML =
      before.replace(/\n/g, "<br/>") +
      `<span id="caret-marker">|</span>` +
      after.replace(/\n/g, "<br/>");

    const marker = mirror.querySelector<HTMLSpanElement>("#caret-marker");
    if (!marker) return;

    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();

    // Offset of caret inside mirror
    const offsetX = markerRect.left - mirrorRect.left;
    const offsetY = markerRect.top - mirrorRect.top;

    // Adjust for textarea scroll so we stay in the visible area
    const visibleOffsetY = offsetY - textarea.scrollTop;

    const containerRect = container.getBoundingClientRect();

    // Get the position of the caret relative to the container
    const finalX = textareaRect.left + offsetX - containerRect.left;
    const finalY =
      textareaRect.top + visibleOffsetY + markerRect.height - containerRect.top;

    setCoords({
      x: finalX,
      y: finalY,
    });
  }, [textareaRef, containerRef, value, caretIndex]);

  return coords;
}
