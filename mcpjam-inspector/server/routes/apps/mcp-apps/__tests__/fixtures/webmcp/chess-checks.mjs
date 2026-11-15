import { readFile } from "node:fs/promises";

/** Run the same production registry/relay against freshly built chess versions. */
export async function checkChessViews(page, check, assert, runtime) {
  for (const [variant, file] of [
    ["legacy", process.env.MCPJAM_CHESS_LEGACY_HTML],
    ["webmcp", process.env.MCPJAM_CHESS_WEBMCP_HTML],
  ]) {
    if (!file) continue;
    const html = await readFile(file, "utf8");
    await check(page, runtime, `chess/${variant}/two-boards`, async () => {
      const result = await page.evaluate(async ({ html }) => {
        const host = window.spike;
        const a = await host.mount({ id: "A", html, mode: "write", permissive: true });
        const b = await host.mount({ id: "B", html, mode: "opaque", permissive: true });
        const state = id => host.call(id, {}, 0, "get_board_state");
        const initialA = await state("A");
        const initialB = await state("B");
        await host.call("A", { san: "e4" });
        const movedA = await state("A");
        const untouchedB = await state("B");
        await host.call("B", { san: "d4" });
        const movedB = await state("B");
        const unchangedA = await state("A");
        // Re-delivery of the original server result is separate from routing.
        await host.notifyToolResult("A", initialA);
        const redeliveredA = await state("A");
        const afterRedeliveryB = await state("B");
        const originalAlias = host.alias("A");
        const secondGameAlias = host.alias("B");
        await host.close("A");
        let absentRejected = false;
        try {
          await host.callAlias(originalAlias, { san: "e4" });
        } catch {
          absentRejected = true;
        }
        await host.mount({ id: "A", html, mode: "write", permissive: true });
        const remountedAlias = host.alias("A");
        await host.callAlias(originalAlias, { san: "e4" });
        const replacementA = await state("A");
        const survivingB = await state("B");
        return { a, b, initialA, initialB, movedA, untouchedB, movedB,
          unchangedA, redeliveredA, afterRedeliveryB, survivingB,
          originalAlias, secondGameAlias, absentRejected, remountedAlias, replacementA };
      }, { html });
      const fen = result => result.structuredContent.fen;
      assert(result.a.source === (variant === "legacy" ? "mcp-apps" : "webmcp"), "Wrong chess source");
      assert(result.b.tools.length === 4, "Opaque chess tools were not registered");
      assert(fen(result.movedA) !== fen(result.initialA), "A did not move");
      assert(fen(result.untouchedB) === fen(result.initialB), "Moving A changed B");
      assert(fen(result.movedB) !== fen(result.initialB), "B did not move");
      assert(fen(result.unchangedA) === fen(result.movedA), "Moving B changed A");
      assert(fen(result.redeliveredA) === fen(result.initialA), "Chess did not honor its server-result contract");
      assert(fen(result.afterRedeliveryB) === fen(result.movedB), "A's server result changed B");
      assert(fen(result.survivingB) === fen(result.movedB), "Closing A changed B");
      assert(result.originalAlias !== result.secondGameAlias, "Separate games shared a tool alias");
      assert(result.absentRejected, "A closed game's alias reached a different game");
      assert(result.originalAlias === result.remountedAlias, "Reload renamed the same widget's tool");
      assert(fen(result.replacementA) === fen(result.movedA), "Stable alias did not reach the remounted board");
    });
  }
}
