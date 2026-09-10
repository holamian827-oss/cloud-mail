import s3Service from './s3-service';
import settingService from './setting-service';
import kvObjService from './kv-obj-service';

const r2Service = {

	async storageType(c) {

		const setting = await settingService.query(c);
		const { bucket, endpoint, s3AccessKey, s3SecretKey } = setting;

		if (!!(bucket && endpoint && s3AccessKey && s3SecretKey)) {
			return 'S3';
		}

		if (c.env.r2) {
			return 'R2';
		}

		return 'KV';
	},

	async putObj(c, key, content, metadata) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.putObj(c, key, content, metadata);
		}

		if (storageType === 'R2') {
			await c.env.r2.put(key, content, {
				httpMetadata: { ...metadata }
			});
		}

		if (storageType === 'S3') {
			await s3Service.putObj(c, key, content, metadata);
		}

	},

	async getObj(c, key) {
		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			// 取不到对象时返回 404 Response，避免调用方解引用 null 导致 500
			return await kvObjService.getObj(c, key) || new Response(null, { status: 404 });
		}

		if (storageType === 'R2') {
			return await c.env.r2.get(key) || new Response(null, { status: 404 });
		}

		if (storageType === 'S3') {
			try {
				return await s3Service.getObj(c, key);
			} catch (e) {
				// S3 对象不存在时 SDK 会抛异常，这里统一转为 404 Response
				if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
					return new Response(null, { status: 404 });
				}
				throw e;
			}
		}
	},

	async delete(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.deleteObj(c, key);
		}

		if (storageType === 'R2') {
			await c.env.r2.delete(key);
		}

		if (storageType === 'S3'){
			await s3Service.deleteObj(c, key);
		}

	}

};
export default r2Service;
