const STORAGE_KEY = "mcp-inspector-server-order";

function loadAllOrders(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveAllOrders(orders: Record<string, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  } catch {
    // Ignore write failures (e.g. quota exceeded)
  }
}

export function loadServerOrder(workspaceId: string): string[] | undefined {
  const all = loadAllOrders();
  return all[workspaceId];
}

export function saveServerOrder(
  workspaceId: string,
  orderedNames: string[],
): void {
  const all = loadAllOrders();
  all[workspaceId] = orderedNames;
  saveAllOrders(all);
}

export function deleteWorkspaceOrder(workspaceId: string): void {
  const all = loadAllOrders();
  delete all[workspaceId];
  saveAllOrders(all);
}
