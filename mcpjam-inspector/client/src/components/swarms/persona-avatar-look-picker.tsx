/**
 * Compact form + mineral look picker for swarm persona pixel golems.
 * Saves immediately via the parent `onSave` (→ `personas:updatePersona`).
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  PERSONA_PIXEL_FAMILY_NAMES,
  PERSONA_PIXEL_MINERAL_NAMES,
  PERSONA_PIXEL_PALETTE_COUNT,
  PERSONA_PIXEL_SHAPE_COUNT,
  PersonaPixelAvatar,
  resolvePersonaPixelLook,
  wrapPersonaPixelIndex,
  type PersonaPixelState,
} from "@/components/swarms/persona-pixel-avatar";

export function PersonaAvatarLookPicker({
  seed,
  avatarShape,
  avatarPalette,
  state,
  onSave,
}: {
  seed: string;
  avatarShape?: number | null;
  avatarPalette?: number | null;
  /** Forwarded to both avatar instances (trigger + preview). */
  state?: PersonaPixelState;
  onSave: (look: {
    avatarShape: number;
    avatarPalette: number;
  }) => Promise<void>;
}) {
  const resolved = resolvePersonaPixelLook(seed, {
    shapeIndex: avatarShape,
    paletteIndex: avatarPalette,
  });
  const [open, setOpen] = useState(false);
  const [shapeIndex, setShapeIndex] = useState(resolved.shapeIndex);
  const [paletteIndex, setPaletteIndex] = useState(resolved.paletteIndex);
  const [saving, setSaving] = useState(false);

  // Sync draft when the persona or persisted look changes (and when closed).
  useEffect(() => {
    if (open) return;
    setShapeIndex(resolved.shapeIndex);
    setPaletteIndex(resolved.paletteIndex);
  }, [open, resolved.shapeIndex, resolved.paletteIndex]);

  const persist = async (nextShape: number, nextPalette: number) => {
    setShapeIndex(nextShape);
    setPaletteIndex(nextPalette);
    setSaving(true);
    try {
      await onSave({
        avatarShape: nextShape,
        avatarPalette: nextPalette,
      });
    } catch {
      setShapeIndex(resolved.shapeIndex);
      setPaletteIndex(resolved.paletteIndex);
    } finally {
      setSaving(false);
    }
  };

  const stepShape = (delta: number) => {
    const next = wrapPersonaPixelIndex(
      shapeIndex + delta,
      PERSONA_PIXEL_SHAPE_COUNT,
    );
    void persist(next, paletteIndex);
  };

  const stepPalette = (delta: number) => {
    const next = wrapPersonaPixelIndex(
      paletteIndex + delta,
      PERSONA_PIXEL_PALETTE_COUNT,
    );
    void persist(shapeIndex, next);
  };

  const familyName = PERSONA_PIXEL_FAMILY_NAMES[shapeIndex] ?? "Form";
  const mineralName = PERSONA_PIXEL_MINERAL_NAMES[paletteIndex] ?? "Mineral";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md outline-none ring-offset-background hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Edit persona look"
          title="Edit look"
          data-testid="persona-avatar-look-trigger"
        >
          <PersonaPixelAvatar
            seed={seed}
            shapeIndex={avatarShape}
            paletteIndex={avatarPalette}
            size="lg"
            active
            state={state}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="flex flex-col items-center gap-3">
          <PersonaPixelAvatar
            seed={seed}
            shapeIndex={shapeIndex}
            paletteIndex={paletteIndex}
            size="lg"
            active
            state={state}
          />
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Form
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={saving}
                aria-label="Previous form"
                onClick={() => stepShape(-1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">
                {familyName} · {shapeIndex + 1}/{PERSONA_PIXEL_SHAPE_COUNT}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={saving}
                aria-label="Next form"
                data-testid="persona-avatar-next-shape"
                onClick={() => stepShape(1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Mineral
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={saving}
                aria-label="Previous mineral"
                onClick={() => stepPalette(-1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">
                {mineralName} · {paletteIndex + 1}/{PERSONA_PIXEL_PALETTE_COUNT}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={saving}
                aria-label="Next mineral"
                data-testid="persona-avatar-next-palette"
                onClick={() => stepPalette(1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Changes save automatically.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
