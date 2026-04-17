import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { GitHubIcon } from "@/components/ui/github-icon";

const REPO = "MCPJam/inspector";
const CACHE_KEY = `gh-stars:${REPO}`;
const CACHE_TTL_MS = 60 * 60 * 1000;

function formatCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k.toFixed(k >= 10 ? 0 : 1)}k`;
  }
  return n.toLocaleString();
}

function readCache(): number | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { count, ts } = JSON.parse(raw) as { count: number; ts: number };
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return count;
  } catch {
    return null;
  }
}

function writeCache(count: number) {
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ count, ts: Date.now() }),
    );
  } catch {
    // ignore
  }
}

export function GitHubStarButton() {
  const [count, setCount] = useState<number | null>(() => readCache());

  useEffect(() => {
    if (count !== null) return;
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const stars = data.stargazers_count;
        if (typeof stars === "number") {
          setCount(stars);
          writeCache(stars);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [count]);

  return (
    <Button asChild variant="outline" size="sm" className="gap-1.5 px-2.5">
      <a
        href={`https://github.com/${REPO}`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Star ${REPO} on GitHub`}
        title={`Star ${REPO} on GitHub`}
      >
        <GitHubIcon className="h-4 w-4" />
        <Star className="h-3.5 w-3.5" />
        <span className="text-xs font-medium">Star</span>
        {count !== null && (
          <span className="text-xs font-medium border-l border-border/60 pl-1.5 ml-0.5 text-muted-foreground">
            {formatCount(count)}
          </span>
        )}
      </a>
    </Button>
  );
}
