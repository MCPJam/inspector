/**
 * Geometry of the Personas sidebar card — what jsdom cannot measure.
 *
 * `/swarms` is members-only, so the fixture rebuilds the card from the
 * component's own class strings rather than driving the real app. It cannot
 * see the DOM restructured underneath those classes;
 * `SwarmsTab.personaCard.test.tsx` covers that.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { compile } from "@tailwindcss/node";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = "client/src/components/swarms/SwarmsTab.tsx";

/** Verbatim from the component. */
const CLS = {
  aside: "flex shrink-0 flex-col border-r",
  scroller: "flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto",
  row: "group flex w-full items-center border-b",
  button:
    "flex min-h-[82px] min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-muted/50",
  textColumn: "flex min-w-0 flex-col gap-0.5",
  name: "line-clamp-2 w-full min-w-0 break-words text-sm font-medium",
  role: "w-full min-w-0 truncate text-xs text-muted-foreground",
};

/** Two of these break naive wrapping: no spaces, and past two lines. */
const PERSONAS = [
  [
    "Impatient enterprise procurement lead",
    "Evalua integraciones de vendors con el deadline encima y firma la compra",
  ],
  [
    "ImpatientEnterpriseProcurementLeadPersona",
    "Un solo token sin espacios, con un rol lo bastante largo como para cortar",
  ],
  [
    "Responsable de compras corporativas del segmento enterprise para LATAM",
    "Excede dos lineas y tambien excede el ancho disponible de una sola linea",
  ],
  // The control: short on both lines, so its role must not be elided.
  ["Ana", "QA"],
  // A quote would end the title attribute early and silently reshape the DOM
  // these tests measure.
  ['Ana "la jefa" Diaz', "QA"],
];

/** The fixture builds attributes by concatenation, so quotes must not end them. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Compiled once: neither the CSS nor the drift check varies per test. */
let fixture: Promise<{ css: string; width: number }> | null = null;

function buildFixture(): Promise<{ css: string; width: number }> {
  const source = readFileSync(`${packageRoot}${SOURCE}`, "utf8");
  const missing = Object.entries(CLS).filter(([, v]) => !source.includes(v));
  expect(
    missing.map(([k]) => k),
    `${SOURCE} no longer contains these class strings — the fixture has drifted from the component and would be measuring a layout nobody ships`,
  ).toEqual([]);

  // The sidebar is resizable, so its width is an inline style rather than a
  // `w-*` class. Read the component's own default instead of hardcoding a
  // number here: every wrapping assertion below is a claim about the width
  // users actually get on open, and a silent change to that default has to
  // re-measure those, not slip past a stale literal.
  const declared = /PERSONA_SIDEBAR_DEFAULT_WIDTH\s*=\s*(\d+)/.exec(source);
  expect(
    declared,
    `${SOURCE} no longer declares PERSONA_SIDEBAR_DEFAULT_WIDTH — the fixture cannot size the column the way the component does`,
  ).not.toBeNull();
  const width = Number(declared![1]);

  return compile(`@import "tailwindcss";\n@theme { --spacing: 0.25rem; }`, {
    base: packageRoot,
    onDependency() {},
  }).then((compiler) => ({
    css: compiler.build([
      ...new Set(Object.values(CLS).flatMap((s) => s.split(/\s+/))),
      "mr-2",
      "size-8",
      "shrink-0",
    ]),
    width,
  }));
}

async function renderSidebar(page: Page): Promise<void> {
  fixture ??= buildFixture();
  const { css, width } = await fixture;

  const rows = PERSONAS.map(
    ([name, role], i) => `
    <div class="${CLS.row}" data-row="${i}">
      <button type="button" class="${CLS.button}">
        <span style="width:32px;height:40px;background:#8aa" class="shrink-0"></span>
        <span class="${CLS.textColumn}">
          <span class="${CLS.name}" data-name="${i}" title="${attr(name)}">${name}</span>
          <span class="${CLS.role}" data-role="${i}" title="${attr(role)}">${role}</span>
        </span>
      </button>
      <span class="mr-2 size-8 shrink-0"></span>
    </div>`,
  ).join("");

  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>${css} html,body{margin:0;font-family:system-ui,sans-serif}</style>
    <div class="flex min-h-0" style="height:420px">
      <aside class="${CLS.aside}" style="width:${width}px" data-aside>
        <div class="${CLS.scroller}" data-scroll>${rows}</div>
      </aside>
      <main class="min-w-0 flex-1"></main>
    </div>`);
}

test.describe("personas sidebar column", () => {
  test.beforeEach(async ({ page }) => {
    await renderSidebar(page);
  });

  test("never scrolls horizontally, whatever the name", async ({ page }) => {
    const overflow = await page.evaluate(() => {
      const sc = document.querySelector("[data-scroll]")!;
      return {
        by: sc.scrollWidth - sc.clientWidth,
        axis: getComputedStyle(sc).overflowX,
      };
    });
    expect(overflow.axis).toBe("hidden");
    expect(overflow.by).toBe(0);
  });

  test("holds the component's default width against a greedy main", async ({
    page,
  }) => {
    // `shrink-0` is the load-bearing class: without it the flex row would pull
    // the column narrower than the width the component set, and every wrapping
    // assertion below would be measuring a layout nobody sees.
    const { width } = await fixture!;
    const box = await page.locator("[data-aside]").boundingBox();
    expect(box?.width).toBe(width);
  });

  test("wraps a long name onto a second line", async ({ page }) => {
    expect(await lineCount(page, "[data-name='0']")).toBe(2);
  });

  test("wraps a name that has no spaces to break on", async ({ page }) => {
    expect(await lineCount(page, "[data-name='1']")).toBe(2);
  });

  test("stops at two lines and elides the rest", async ({ page }) => {
    const el = page.locator("[data-name='2']");
    expect(await lineCount(page, "[data-name='2']")).toBe(2);
    expect(await el.evaluate((n) => n.scrollHeight > n.clientHeight + 1)).toBe(
      true,
    );
  });

  test("keeps every role on a single line", async ({ page }) => {
    for (const i of PERSONAS.keys()) {
      expect(await lineCount(page, `[data-role='${i}']`)).toBe(1);
    }
  });

  test("ellipses a role that overruns, and leaves a short one alone", async ({
    page,
  }) => {
    // scrollWidth past clientWidth is the ellipsis engaging.
    const elided = (i: number) =>
      page
        .locator(`[data-role='${i}']`)
        .evaluate((n) => n.scrollWidth > n.clientWidth);

    for (const i of [0, 1, 2]) expect(await elided(i)).toBe(true);
    expect(await elided(3)).toBe(false);
    expect(await elided(4)).toBe(false);
  });

  test("gives a one-word name the same card height as a wrapped one", async ({
    page,
  }) => {
    const heights = await page
      .locator("[data-row]")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights).toHaveLength(PERSONAS.length);
    expect(new Set(heights).size).toBe(1);
  });

  // `title` is not asserted here: this fixture writes it, so the check could
  // never fail. `SwarmsTab.personaCard.test.tsx` covers it.
});

async function lineCount(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .evaluate((el) =>
      Math.round(
        el.getBoundingClientRect().height /
          parseFloat(getComputedStyle(el).lineHeight),
      ),
    );
}
