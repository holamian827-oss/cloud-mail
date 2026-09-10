import { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import settingService from './setting-service';
import domainUtils from '../utils/domain-uitls';
import { settingConst } from '../const/entity-const';
const s3Service = {

	async putObj(c, key, content, metadata) {

		const client = await this.client(c);

		const { bucket } = await settingService.query(c);

		let obj = { Bucket: bucket, Key: key, Body: content,
			CacheControl: metadata.cacheControl
		}

		if (metadata.cacheControl) {
			obj.CacheControl = metadata.cacheControl
		}

		if (metadata.contentDisposition) {
			obj.ContentDisposition = metadata.contentDisposition
		}

		if (metadata.contentType) {
			obj.ContentType = metadata.contentType
		}

		await client.send(new PutObjectCommand(obj))
	},

	async deleteObj(c, keys) {

		if (typeof keys === 'string') {
			keys = [keys];
		}

		if (keys.length === 0) {
			return;
		}

		const client = await this.client(c);
		const { bucket } = await settingService.query(c);

		// DeleteObjects 需要的校验和由 AWS SDK 自动计算并添加；
		// 之前手动计算 Content-MD5 会调用 Workers WebCrypto 不支持的 MD5 而必然抛错，导致对象永远删不掉
		await client.send(
			new DeleteObjectsCommand({
				Bucket: bucket,
				Delete: {
					Objects: keys.map(key => ({ Key: key }))
				}
			})
		);
	},

	async getObj(c, key) {
		const client = await this.client(c);
		const { bucket } = await settingService.query(c);
		const result = await client.send(new GetObjectCommand({
			Bucket: bucket,
			Key: key
		}));

		return new Response(result.Body, {
			headers: {
				'Content-Type': result.ContentType || 'application/octet-stream',
				'Content-Disposition': result.ContentDisposition || null,
				'Cache-Control': result.CacheControl || null
			}
		});
	},


	async client(c) {
		const { region, endpoint, s3AccessKey, s3SecretKey, forcePathStyle } = await settingService.query(c);
		return new S3Client({
			region: region || 'auto',
			endpoint: domainUtils.toOssDomain(endpoint),
			forcePathStyle: forcePathStyle === settingConst.forcePathStyle.OPEN,
			credentials: {
				accessKeyId: s3AccessKey,
				secretAccessKey: s3SecretKey,
			}
		});
	}
}

export default s3Service
