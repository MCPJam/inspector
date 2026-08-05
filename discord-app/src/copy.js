import { BUTTON_LABELS } from "@mcpjam/surface-core";

/** @param {string} reply @param {Array<any>} [proposals] */
export function turnContent(reply, proposals = []) {
	const rows = [];
	for (const proposal of proposals.slice(0, 5)) {
		if (!proposal?.actionId || String(proposal.actionId).length > 100) continue;
		rows.push({
			type: 1,
			components: [
				{
					type: 2,
					style: 1,
					label:
						BUTTON_LABELS[
							/** @type {keyof typeof BUTTON_LABELS} */ (proposal.operation)
						] || "Approve",
					custom_id: proposal.actionId,
				},
			],
		});
	}
	/** @type {any} */
	const content = {
		severity: "info",
		parts: [reply || "Done — though I have nothing to add."],
		...(rows.length ? { blocks: rows } : {}),
	};
	return content;
}

/** @param {string} text */
export function statusContent(text) {
	return /** @type {any} */ ({ severity: "info", parts: [text] });
}
