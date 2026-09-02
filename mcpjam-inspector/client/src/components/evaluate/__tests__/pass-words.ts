/**
 * The pass-word regex, shared by the run-page models that produce headlines.
 *
 * The identical literal already lives in `stage-chain-model.test.ts` and
 * `stage-trial-model.test.ts`, copied between them on purpose: two surfaces
 * that disagree about what counts as a pass word would each be individually
 * green while the product says "healthy" somewhere. This file does not replace
 * those copies — editing either of them without editing this one is the drift
 * they were guarding against, so all three must move together.
 *
 * It is a file rather than a third copy because the run page adds several new
 * label producers at once (the verdict word, the case-row mark, the diff pill),
 * and a per-file copy for each would make the drift likelier, not less likely.
 */
export const PASS_WORDS =
  /\b(pass|passed|ok|healthy|good|connected|discovered|selected|made|returned|satisfied)\b/i;
