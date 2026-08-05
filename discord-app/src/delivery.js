import { renderDiscord } from "./renderer.js";

export class DiscordDeliverySurface {
	/** @param {{renderer?:typeof renderDiscord}} [options] */
	constructor(options = {}) {
		this.renderer = options.renderer || renderDiscord;
	}
	/** @param {any} ref @param {import('@mcpjam/surface-core').StructuredContent} content */
	async deliver(ref, content) {
		const payloads = this.renderer(content);
		const handles = [];
		for (const payload of payloads) {
			const message = ref.message?.reply
				? await ref.message.reply(payload)
				: await ref.channel.send(payload);
			handles.push({ id: message.id, message, isStatus: handles.length === 0 });
		}
		return { handles };
	}
	/** @param {{message?:any,id:string}} handle @param {import('@mcpjam/surface-core').StructuredContent} content */
	async edit(handle, content) {
		const payload = this.renderer(content)[0];
		await (handle.message || handle).edit(payload);
	}
	/** @param {any} ref @param {Array<{url:string,label?:string}>} images */
	async uploadImages(ref, images) {
		if (!images?.length) return { handles: [] };
		const channel = ref.channel || ref.message?.channel;
		if (!channel) throw new Error("Discord delivery requires a channel.");
		const message = await channel.send({
			files: images.map((image) => ({
				attachment: image.url,
				name: `${image.label || "evidence"}.png`,
			})),
			allowedMentions: { parse: [], users: [], roles: [] },
		});
		return { handles: [{ id: message.id, message }] };
	}
}
