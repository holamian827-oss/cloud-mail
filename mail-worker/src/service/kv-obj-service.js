import fileUtils from '../utils/file-utils';

const kvObjService = {

	async putObj(c, key, content, metadata) {
		await c.env.kv.put(key, content, { metadata: metadata });
	},

	async deleteObj(c, keys) {

		if (typeof keys === 'string') {
			keys = [keys];
		}

		if (keys.length === 0) {
			return;
		}

		await Promise.all(keys.map( key => c.env.kv.delete(key)));
	},

	async getObj(c, key) {
		const obj = await c.env.kv.getWithMetadata(key, { type: "arrayBuffer"});
		if (!obj.value) {
			// 取不到对象时返回 404 Response 而非 null，避免调用方直接取 body 崩溃
			return new Response(null, { status: 404 });
		}

		const contentType = obj.metadata?.contentType || 'application/octet-stream';

		// HTML/SVG 这类能被当作页面执行的内容，无论存的时候标了什么 disposition，
		// 一律强制下载。这是 /attachments/<hash>.html 存储型 XSS 的兜底。
		const contentDisposition = fileUtils.isDangerousInlineType(contentType)
			? 'attachment'
			: obj.metadata?.contentDisposition;

		// 只在有值时才设置这些头：原来写成 `|| null`，而 Headers 会把 null
		// 序列化成字符串 "null"，反而发出一个非法的 `Content-Disposition: null`。
		const headers = new Headers({
			'Content-Type': contentType,
			'X-Content-Type-Options': 'nosniff'
		});
		if (contentDisposition) headers.set('Content-Disposition', contentDisposition);
		if (obj.metadata?.cacheControl) headers.set('Cache-Control', obj.metadata.cacheControl);

		return new Response(obj.value, { headers });
	},

	async toObjResp(c, key) {

		return await this.getObj(c, key);

	}

};

export default kvObjService;
