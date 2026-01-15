/**
 * @file Liked cocktails widget app using MCP Apps SDK + React.
 */
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { CocktailData } from "./lib/types";
import styles from "./liked-cocktails-widget.module.css";

const IMPLEMENTATION = { name: "Liked Cocktails Widget", version: "1.0.0" };

const log = {
  info: console.log.bind(console, "[APP]"),
  warn: console.warn.bind(console, "[APP]"),
  error: console.error.bind(console, "[APP]"),
};

function extractLikedCocktails(callToolResult: {
  structuredContent?: unknown;
}): CocktailData[] {
  const structured = callToolResult.structuredContent as
    | { cocktails?: CocktailData[] }
    | undefined;
  return structured?.cocktails ?? [];
}

function LikedCocktailsApp() {
  const [cocktails, setCocktails] = useState<CocktailData[]>([]);
  const [status, setStatus] = useState("Loading liked cocktails...");
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [hasRequested, setHasRequested] = useState(false);
  console.log("hostContext", hostContext); 

  const { app, error } = useApp({
    appInfo: IMPLEMENTATION,
    capabilities: {},
    onAppCreated: (app) => {
      app.onteardown = async () => {
        log.info("App is being torn down");
        return {};
      };

      app.ontoolresult = async (result) => {
        log.info("Received tool call result:", result);
        if (result.isError) {
          setStatus("Failed to load liked cocktails.");
          return;
        }

        const liked = extractLikedCocktails(result);
        setCocktails(liked);
        setStatus(liked.length ? "Updated just now." : "No liked cocktails yet.");
      };

      app.ontoolcancelled = async (params) => {
        log.warn("Tool call cancelled:", params);
        setStatus("Liked cocktails request cancelled.");
      };

      app.onerror = log.error;

      app.onhostcontextchanged = (params) => {
        log.info("Host context changed:", params);
        setHostContext((prev) => ({ ...prev, ...params }));
      };
    },
  });

  app?.getHostContext()?.styles?.variables?.["--color-background-primary"];

  useEffect(() => {
    if (app) {
      setHostContext(app.getHostContext());
    }
  }, [app]);

  useEffect(() => {
    if (!app || hasRequested) return;
    setHasRequested(true);

    app
      .callServerTool({ name: "get_liked_cocktails", arguments: {} })
      .then((result) => {
        if (result.isError) {
          setStatus("Failed to load liked cocktails.");
          return;
        }
        const liked = extractLikedCocktails(result);
        setCocktails(liked);
        setStatus(liked.length ? "Updated just now." : "No liked cocktails yet.");
      })
      .catch((toolError) => {
        log.error(toolError);
        setStatus("Failed to load liked cocktails.");
      });
  }, [app, hasRequested]);

  const rows = useMemo(
    () =>
      cocktails.map((cocktail, index) => {
        const meta = [
          `${cocktail.nutrition.abv}% ABV`,
          `${cocktail.nutrition.volume}ml`,
          `${cocktail.ingredients.length} ingredients`,
        ];
        return (
          <article
            key={cocktail.id}
            className={styles.row}
            style={{ "--delay": `${index * 60}ms` } as CSSProperties}
          >
            <div className={styles.rowMain}>
              <div className={styles.rowTitle}>
                <h2 className={styles.name}>{cocktail.name}</h2>
                <span className={styles.tagline}>{cocktail.tagline}</span>
              </div>
              <div className={styles.metaRow}>
                {meta.map((item) => (
                  <span key={item} className={styles.metaItem}>
                    {item}
                  </span>
                ))}
                <span className={styles.metaItem}>
                  {cocktail.garnish ? `Garnish: ${cocktail.garnish}` : "No garnish"}
                </span>
                <span className={styles.metaItem}>{cocktail.nutrition.calories} cal</span>
              </div>
            </div>
            <div className={styles.rowImage}>
              {cocktail.image?.url ? (
                <img
                  src={cocktail.image.url}
                  alt={cocktail.name}
                  className={styles.image}
                />
              ) : (
                <div className={styles.imageFallback}>Image unavailable</div>
              )}
            </div>
          </article>
        );
      }),
    [cocktails],
  );

  if (error) return <div className={styles.status}>Error: {error.message}</div>;
  if (!app) return <div className={styles.status}>Connecting...</div>;

  return (
    <main
      className={styles.shell}
      style={{
        ...(hostContext?.styles?.variables as CSSProperties),
        paddingTop: hostContext?.safeAreaInsets?.top,
        paddingRight: hostContext?.safeAreaInsets?.right,
        paddingBottom: hostContext?.safeAreaInsets?.bottom,
        paddingLeft: hostContext?.safeAreaInsets?.left,
      }}
    >
      <section className={styles.frame}>
        <header className={styles.header}>
          <span className={styles.eyebrow}>Your Liked List</span>
          <h1 className={styles.title}>Saved Cocktails</h1>
          <p className={styles.subtitle}>
            {cocktails.length
              ? `${cocktails.length} recipes waiting for your next pour.`
              : "Build your shortlist of favorites and keep them ready for the next gathering."}
          </p>
        </header>

        {!cocktails.length ? (
          <div className={styles.statusCard}>{status}</div>
        ) : (
          <div className={styles.list}>{rows}</div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LikedCocktailsApp />
  </StrictMode>,
);
