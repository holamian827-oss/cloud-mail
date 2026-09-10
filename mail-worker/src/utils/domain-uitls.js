const domainUtils = {

	/**
	 * 统一的「本站允许的邮箱域名」读取口（返回裸域名数组，不含 @）。
	 *
	 * 必须收口到这一个函数的原因：
	 * c.env.domain 在官方部署流水线里是 JSON 数组，但它也可能被配置成裸字符串，
	 * 而 **`"字符串".includes(x)` 是子串匹配** —— 一旦配成 "example.com"，
	 * 那么 "ple.com"、"e.com" 都会被判为合法域名，等于对任意域名开放注册。
	 * 所以所有建号/加邮箱的入口都必须走这里，不要直接对 c.env.domain 调 includes。
	 */
	allowedDomains(c) {
		const raw = c?.env?.domain;

		if (Array.isArray(raw)) {
			return raw;
		}

		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed : [];
			} catch (e) {
				// 不是 JSON。刻意返回空数组而不是按逗号切分：
				// 配置错误时应该「谁也注册不了」，而不是「谁都能注册」。
				return [];
			}
		}

		return [];
	},

	/** 邮箱是否属于本站允许的域名。精确匹配，不做任何子串/模糊判断。 */
	isAllowedEmailDomain(c, email) {
		const value = String(email || '');
		const at = value.lastIndexOf('@');

		if (at < 0) {
			return false;
		}

		const domain = value.slice(at + 1).toLowerCase();

		return this.allowedDomains(c).some(item => String(item).toLowerCase() === domain);
	},

	toOssDomain(domain) {

		if (!domain) {
			return null
		}

		if (!domain.startsWith('http')) {
			return 'https://' + domain
		}

		if (domain.endsWith("/")) {
			domain = domain.slice(0, -1);
		}

		return domain
	}
}

export default  domainUtils
