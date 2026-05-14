/**
 * Module-level dirty flag for the Playground tab.
 *
 * `useViewState` lives inside `PlaygroundTab`'s subtree, so `applyNavigation`
 * in `App.tsx` can't reach it through context. The Playground writes its
 * `isDirty` state here via a `useEffect`; `applyNavigation` reads
 * `isPlaygroundDirty()` synchronously when the user attempts to leave
 * `#playground` and prompts to confirm losing the edits.
 */
let dirty = false;

export function setPlaygroundDirty(next: boolean): void {
  dirty = next;
}

export function isPlaygroundDirty(): boolean {
  return dirty;
}
