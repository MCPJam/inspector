// Browser page translators (Chrome, Edge) swap React's text nodes for their
// own `<font>` wrappers. React still holds the old nodes, so the next
// `removeChild` / `insertBefore` on them throws NotFoundError and the route
// crashes. When a node is no longer where React left it, skip the DOM call
// instead of throwing. See https://github.com/facebook/react/issues/11538.
//
// Returns a function that restores the original DOM methods (for tests).
export function installTranslatedPageDomGuard(): () => void {
  if (typeof Node !== "function" || !Node.prototype) return () => {};

  const originalRemoveChild = Node.prototype.removeChild;
  const originalInsertBefore = Node.prototype.insertBefore;

  Node.prototype.removeChild = function <T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) return child;
    return originalRemoveChild.call(this, child) as T;
  };

  Node.prototype.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    child: Node | null,
  ): T {
    if (child && child.parentNode !== this) return node;
    return originalInsertBefore.call(this, node, child) as T;
  };

  return () => {
    Node.prototype.removeChild = originalRemoveChild;
    Node.prototype.insertBefore = originalInsertBefore;
  };
}
