import domainUtils from '../utils/domain-uitls';

// 回环/内网地址与内网主机名,禁止作为出站 webhook 目标(防SSRF)
const PRIVATE_HOST_PATTERNS = [
	/^localhost$/,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^169\.254\./,								// 链路本地(含云元数据 169.254.169.254)
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,	// 100.64.0.0/10 运营商级 NAT
	/^0\.0\.0\.0$/,
	/^::1$/,
	/^::$/,										// IPv6 未指定地址
	/^::ffff:/,									// IPv4-mapped IPv6,如 ::ffff:127.0.0.1
	/^f[cd][0-9a-f]{2}:/,						// 唯一本地地址
	/^fe80:/,									// 链路本地
	/\.local$/,
	/\.internal$/
];

const webhookService = {

	async sendEmail(c, emailRow, webhookUrl, retry = 0, webhookSecret) {

		webhookUrl = domainUtils.toOssDomain(webhookUrl);

		if (!webhookUrl) {
			return;
		}

		// 只允许 https 且非内网地址,避免被用作SSRF跳板
		if (!isSafeWebhookUrl(webhookUrl)) {
			console.error(`Webhook 地址不合法(必须为https且不能指向内网地址),已跳过: ${webhookUrl}`);
			return;
		}

		retry = Number(retry);
		if (isNaN(retry) || retry < 0) {
			retry = 0;
		}

		const headers = {
			'Content-Type': 'application/json'
		};

		if (webhookSecret) {
			headers['Authorization'] = webhookSecret;
		}

		const body = JSON.stringify({
			emailId: emailRow.emailId,
			sendEmail: emailRow.sendEmail,
			sendName: emailRow.name,
			toEmail: emailRow.toEmail,
			toName: emailRow.toName,
			subject: emailRow.subject,
			text: emailRow.text,
			content: emailRow.content,
			code: emailRow.code,
			createTime: emailRow.createTime
		});

		let lastError = '';

		for (let i = 0; i <= retry; i++) {
			try {
				const res = await fetch(webhookUrl, {
					method: 'POST',
					headers,
					body
				});

				if (res.ok) {
					return;
				}

				lastError = `status: ${res.status} response: ${await res.text()}`;
			} catch (e) {
				lastError = e.message;
			}
		}

		console.error(`Webhook 推送失败: ${lastError}`);
	}

};

function isSafeWebhookUrl(url) {

	let parsed;

	try {
		parsed = new URL(url);
	} catch (e) {
		return false;
	}

	if (parsed.protocol !== 'https:') {
		return false;
	}

	const host = (parsed.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

	if (!host) {
		return false;
	}

	// 十进制 / 十六进制形式的 IPv4:https://2130706433/ 其实就指向 127.0.0.1,
	// 但 URL 解析不会把它归一化成点分格式,只能按字面形态拦。
	if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
		return false;
	}

	// 说明:这里只能做字面量与网段判断。用域名指向内网(如 xip.io)或
	// DNS rebinding 仍可能绕过 —— 要彻底解决得先解析 DNS 再校验解析结果,
	// 而 Workers 里这一步既不可靠也拿不到全部记录类型,故未做。
	return !PRIVATE_HOST_PATTERNS.some(pattern => pattern.test(host));
}

export default webhookService;
