const MAX_CONTENT = 2_000;

/** @param {any} part @param {string[]} users */
function renderPart(part, users) {
	if (typeof part === "string") return part;
	if (part?.mention) {
		users.push(String(part.mention));
		return `<@${part.mention}>`;
	}
	if (part?.link) return `[${part.link.label}](${part.link.url})`;
	if (part?.code) return `\`\`\`${part.language || ""}\n${part.code}\n\`\`\``;
	return "";
}

/** @param {string} text @param {number} max */
function chunkText(text, max) {
	if (text.length <= max) return [text];
	const chunks = [];
	let remaining = text;
	while (remaining.length > max) {
		let cut = remaining.lastIndexOf("\n", max);
		if (cut < Math.floor(max * 0.5)) cut = remaining.lastIndexOf(" ", max);
		if (cut < Math.floor(max * 0.5)) cut = max;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut).trimStart();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

/**
 * Render only native Discord payloads. Every payload carries explicit mention
 * policy, and component rows are attached only to the final chunk.
 * @param {any} content
 * @returns {Array<{content:string,allowedMentions:{parse:string[],users:string[],roles:string[]},components?:any[]}>}
 */
export function renderDiscord(content) {
	/** @type {string[]} */ const users = [];
	const text = (content?.parts || [])
		.map((/** @type {any} */ part) => renderPart(part, users))
		.join("");
	const chunks = chunkText(text || "\u200b", MAX_CONTENT);
	/** @type {Array<{content:string,allowedMentions:{parse:string[],users:string[],roles:string[]},components?:any[]}>} */
	const payloads = chunks.map((chunk) => ({
		content: chunk,
		allowedMentions: { parse: [], users: [...new Set(users)], roles: [] },
	}));
	if (content?.blocks?.length)
		payloads[payloads.length - 1].components = content.blocks;
	return payloads;
}

export { chunkText, MAX_CONTENT };
