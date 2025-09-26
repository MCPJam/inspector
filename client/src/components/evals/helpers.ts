export function formatTime(ts?: number) {
    return ts ? new Date(ts).toLocaleString() : "—";
  }