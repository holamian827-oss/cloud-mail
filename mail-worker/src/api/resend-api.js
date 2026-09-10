import resendService from '../service/resend-service';
import app from '../hono/hono';
app.post('/webhooks',async (c) => {
	try {
		// 只读取一次原始请求体,用于 Svix 签名校验(签名基于原始字符串,不能再调用 c.req.json())
		const rawBody = await c.req.text();
		await resendService.webhooks(c, rawBody);
		return c.text('success', 200)
	} catch (e) {
		// 业务错误(如签名校验失败)用它自己的状态码,让 Resend 能区分
		// 「被拒绝」和「服务端故障」;其余一律 500。
		// 这里必须确认是整数:某些运行时错误会把 e.code 设成 'ERR_xxx' 之类的字符串,
		// 直接传给 c.text 会再抛一次。
		const status = Number.isInteger(e.code) ? e.code : 500
		return c.text(e.message, status)
	}
})
