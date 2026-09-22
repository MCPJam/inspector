// @ts-nocheck
import { renderDiscordChunks } from "./renderer.js";

export function createDiscordDelivery(channel) {
	return {
		async deliver(_ref, content, options = {}) {
			const handles = [];
			for (const payload of renderDiscordChunks(content, options)) {
				const message = await channel.send(payload);
				handles.push({ id: message.id, channelId: message.channelId, message });
			}
			return { handles };
		},
		async edit(handle, content, options = {}) {
			const message =
				handle.message || (await channel.messages.fetch(handle.id));
			const payload = renderDiscordChunks(content, options)[0];
			return message.edit(payload);
		},
		async uploadImages(_ref, images) {
			return channel.send({ files: images, allowedMentions: { parse: [] } });
		},
	};
}
