import { useEffect, useRef, useState } from "react";

export interface UseTypewriterStringOptions {
  /** When false, output stays empty until active becomes true; then animation runs (or full string if reducedMotion). */
  active: boolean;
  msPerChar: number;
  reducedMotion: boolean;
}

/**
 * Reveals `target` one character at a time for a typewriter effect.
 * When `reducedMotion` is true, returns the full `target` immediately while active.
 */
export function useTypewriterString(
  target: string,
  { active, msPerChar, reducedMotion }: UseTypewriterStringOptions,
): { text: string; isComplete: boolean } {
  const [text, setText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!active || !target) {
      setText("");
      setIsComplete(false);
      return;
    }

    if (reducedMotion) {
      setText(target);
      setIsComplete(true);
      return;
    }

    setText("");
    setIsComplete(false);

    let index = 0;
    const id = window.setInterval(() => {
      index += 1;
      const next = targetRef.current.slice(0, index);
      setText(next);
      if (index >= targetRef.current.length) {
        window.clearInterval(id);
        setIsComplete(true);
      }
    }, msPerChar);

    return () => {
      window.clearInterval(id);
    };
  }, [active, target, msPerChar, reducedMotion]);

  return { text, isComplete };
}
