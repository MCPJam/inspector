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
