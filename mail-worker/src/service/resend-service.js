import emailService from './email-service';
import { emailConst } from '../const/entity-const';
import BizError from '../error/biz-error';

const encoder = new TextEncoder();

// Resend 的投递状态事件白名单,未知事件直接忽略,避免误更新状态
const KNOWN_EVENT_TYPES = [
	'email.sent',
	'email.delivered',
	'email.complained',
	'email.bounced',
	'email.delivery_delayed',
	'email.failed'
];

const resendService = {

	async webhooks(c, rawBody) {

		await this.verifySignature(c, rawBody);

		let body;

		try {
			body = JSON.parse(rawBody);
		} catch (e) {
			return;
		}

		const data = body?.data;

		if (!data || !data.email_id || !KNOWN_EVENT_TYPES.includes(body.type)) {
			return;
		}

		const params = {
			resendEmailId: data.email_id,
			status: emailConst.status.SENT,
			message: null
		}

		if (body.type === 'email.delivered') {
			params.status = emailConst.status.DELIVERED
		}

		if (body.type === 'email.complained') {
			params.status = emailConst.status.COMPLAINED
		}

		if (body.type === 'email.bounced') {
			const bounce = data.bounce
			params.status = emailConst.status.BOUNCED
			params.message = bounce ? JSON.stringify(bounce) : null
		}

		if (body.type === 'email.delivery_delayed') {
			params.status = emailConst.status.DELAYED
		}

		if (body.type === 'email.failed') {
			params.status = emailConst.status.FAILED
			params.message = data.failed?.reason || null
		}

		const emailRow = await emailService.updateEmailStatus(c, params)

		if (!emailRow) {
			throw new BizError('更新邮件状态记录失败');
		}

	},

	// Resend/Svix 签名校验:签名串为 `${svixId}.${svixTimestamp}.${rawBody}`,
	// key 为 secret 去掉 whsec_ 前缀后的 base64 解码结果,HMAC-SHA256 后 base64
	async verifySignature(c, rawBody) {

		const secret = c.env.resend_webhook_secret;

		// secret 未配置时保持原行为,仅告警提示
		if (!secret) {
			console.warn('resend_webhook_secret 未配置,已跳过 Resend webhook 签名校验,投递状态可能被伪造');
			return;
		}

		const svixId = c.req.header('svix-id');
		const svixTimestamp = c.req.header('svix-timestamp');
		const svixSignature = c.req.header('svix-signature');

		if (!svixId || !svixTimestamp || !svixSignature) {
			throw new BizError('缺少 webhook 签名头', 401);
		}

		// 时间戳偏差超过 5 分钟视为非法,防重放
		const timestamp = Number(svixTimestamp);

		if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
			throw new BizError('webhook 签名时间戳无效', 401);
		}

		const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''));

		if (!keyBytes) {
			throw new BizError('webhook 签名密钥无效', 401);
		}

		const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

		const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${svixId}.${svixTimestamp}.${rawBody}`));
		const expected = bytesToBase64(new Uint8Array(signature));

		// svix-signature 形如 `v1,<base64>`,可能为空格分隔的多个签名
		const valid = svixSignature.split(' ').some(item => {
			const [version, sig] = item.split(',');
			return version === 'v1' && timingSafeEqual(sig, expected);
		});

		if (!valid) {
			throw new BizError('webhook 签名校验失败', 401);
		}

	}

}

function base64ToBytes(str) {

	try {
		return Uint8Array.from(atob(str), char => char.charCodeAt(0));
	} catch (e) {
		return null;
	}

}

function bytesToBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

// 恒定时间字符串比较,避免签名比对时的时序泄露
function timingSafeEqual(a, b) {

	if (typeof a !== 'string' || typeof b !== 'string') {
		return false;
	}

	if (a.length !== b.length) {
		return false;
	}

	let diff = 0;

	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}

	return diff === 0;
}

export default resendService
