// @ts-nocheck
import { plainText } from "@mcpjam/surface-core";

function discordText(content) {
	return (content?.parts || [])
		.map((part) => {
			if (typeof part === "string") return part;
			if (part?.mention) return `<@${part.mention}>`;
			if (part?.link)
				return `[${part.link.label || part.link.url}](${part.link.url})`;
			if (part?.code) return `\`${String(part.code).replace(/`/g, "\\`")}\``;
			return "";
		})
		.join("");
}

/** Render structured content without letting core depend on Discord markup. */
export function renderDiscord(content, { components = [] } = {}) {
	const text = content?.parts ? discordText(content) : plainText(content);
	const body = text.replace(
		/@everyone|@here|<@&\d+>/g,
		(match) => `\\${match}`,
	);
	return {
		content: body,
		components,
		allowedMentions: {
			parse: [],
			users: (content?.parts || [])
				.filter((part) => part && typeof part === "object" && "mention" in part)
				.map((part) => part.mention),
		},
	};
}

/** Discord's hard 2,000-character message limit. */
export function chunkDiscordText(text, maxLength = 2_000) {
	const chunks = [];
	for (let offset = 0; offset < text.length; offset += maxLength)
		chunks.push(text.slice(offset, offset + maxLength));
	return chunks.length ? chunks : [""];
}

export function renderDiscordChunks(content, options = {}) {
	const proposalComponents = (content?.proposedActions || [])
		.slice(0, 5)
		.map((proposal) => ({
			type: 2,
			style: 1,
			label: String(proposal.buttonLabel || "Approve").slice(0, 80),
			custom_id: String(proposal.actionId).slice(0, 100),
		}));
	const components =
		options.components ||
		(proposalComponents.length
			? [{ type: 1, components: proposalComponents }]
			: []);
	return chunkDiscordText(renderDiscord(content, options).content).map(
		(text, index, all) => ({
			content: text,
			allowedMentions: renderDiscord(content).allowedMentions,
			components: index === all.length - 1 ? components : [],
		}),
	);
}
