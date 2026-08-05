// @ts-nocheck
/**
 * Keep screenshot selection deliberately local. The SDK platform module is
 * mirrored by design: importing it would pull a large runtime into bot images.
 */
export function selectRunEvidence(run, options = {}) {
	const limit = options.limit ?? 3;
	const screenshots = [];
	const visit = (value) => {
		if (!value || screenshots.length >= limit) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object") return;
		for (const key of ["screenshotUrl", "screenshot", "imageUrl"])
			if (typeof value[key] === "string") screenshots.push({ url: value[key] });
		for (const key of ["steps", "iterations", "result", "summary"])
			visit(value[key]);
	};
	visit(run);
	return screenshots.slice(0, limit);
}

/** @param {any} run @returns {Array<{url:string,label:string}>} */
export function evidenceImages(run) {
	return selectRunEvidence(run).map((image, index) => ({
		...image,
		label: `Evidence ${index + 1}`,
	}));
}

/**
 * Fetch bounded, failure-first screenshot evidence for a terminal run. The
 * adapter decides how the returned URLs become native attachments.
 * @param {{apiClient:any,runId:string,ctx:any,limit?:number}} args
 */
export async function fetchRunEvidence({ apiClient, runId, ctx, limit = 5 }) {
	if (!apiClient?.listEvalRunIterations || !apiClient?.getEvalRunSteps)
		return [];
	const iterations = await apiClient.listEvalRunIterations(runId, ctx, {
		limit: 25,
	});
	const ordered = [...iterations].sort((left, right) => {
		const leftFailed = left?.status === "failed" || left?.result === "failed";
		const rightFailed =
			right?.status === "failed" || right?.result === "failed";
		return Number(rightFailed) - Number(leftFailed);
	});
	const steps = [];
	for (const iteration of ordered.slice(0, 3)) {
		const id = iteration?.id || iteration?.iterationId;
		if (!id) continue;
		steps.push(...(await apiClient.getEvalRunSteps(runId, id, ctx)));
	}
	const seen = new Set();
	return steps
		.sort((left, right) => (left?.stepIndex ?? 0) - (right?.stepIndex ?? 0))
		.filter((step) => {
			const url = step?.evidence?.screenshotUrl || step?.screenshotUrl;
			if (!url || seen.has(url)) return false;
			seen.add(url);
			return true;
		})
		.slice(0, limit)
		.map((step, index) => ({
			url: step.evidence?.screenshotUrl || step.screenshotUrl,
			label: step.evidence?.locatorLabel || `Evidence ${index + 1}`,
		}));
}
