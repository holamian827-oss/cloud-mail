/**
 * 安全事件日志。
 *
 * 目的：让「谁、什么时候、做了什么敏感操作」有痕迹可查。安全事件没有日志，
 * 出事之后就只能靠猜。
 *
 * 为什么用 console.log 而不是写库：
 *   - wrangler.toml 里已经开了 [observability]，Workers 会收集控制台输出，
 *     管理员在 Cloudflare 面板就能按字段检索，不需要额外建表；
 *   - 写库意味着在**已经失败的路径**（登录失败、触发限流）上再加一次写入，
 *     写入本身还可能失败，反而把主流程拖下水。日志必须是无害的旁路。
 *
 * 输出格式：单行 JSON，固定带 scope=security，便于过滤。
 */
const securityLog = {

	write(event, detail = {}) {
		try {
			console.log(JSON.stringify({
				scope: 'security',
				event,
				time: new Date().toISOString(),
				...detail
			}))
		} catch (e) {
			// 记日志本身绝不能影响业务流程
		}
	}

}

export default securityLog
