import type { EnrichedRegistryCatalogCard } from "@/hooks/useRegistryServers";

/** Pinned to the front among same-tier Quick Connect cards (after App preference). */
const QUICK_CONNECT_PINNED_DISPLAY_NAMES = ["Excalidraw", "Asana"] as const;

const UNPINNED_RANK = QUICK_CONNECT_PINNED_DISPLAY_NAMES.length;

function catalogCardHasAppVariant(card: EnrichedRegistryCatalogCard): boolean {
  return card.variants.some((v) => v.clientType === "app");
}

function quickConnectPinnedRank(displayName: string): number {
  const idx = QUICK_CONNECT_PINNED_DISPLAY_NAMES.indexOf(
    displayName as (typeof QUICK_CONNECT_PINNED_DISPLAY_NAMES)[number],
  );
  return idx === -1 ? UNPINNED_RANK : idx;
}

/**
 * Sort order for Servers tab Quick Connect: App-capable cards first, then pinned
 * Excalidraw → Asana, then remaining cards by {@link EnrichedRegistryCatalogCard.catalogSortOrder}.
 */
export function compareQuickConnectCatalogCards(
  a: EnrichedRegistryCatalogCard,
  b: EnrichedRegistryCatalogCard,
): number {
  const appA = catalogCardHasAppVariant(a) ? 0 : 1;
  const appB = catalogCardHasAppVariant(b) ? 0 : 1;
  if (appA !== appB) return appA - appB;

  const nameA = a.variants[0]?.displayName ?? "";
  const nameB = b.variants[0]?.displayName ?? "";
  const pinA = quickConnectPinnedRank(nameA);
  const pinB = quickConnectPinnedRank(nameB);
  if (pinA !== pinB) return pinA - pinB;

  return a.catalogSortOrder - b.catalogSortOrder;
}
