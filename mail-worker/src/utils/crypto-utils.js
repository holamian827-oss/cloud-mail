const encoder = new TextEncoder();

// 密码哈希使用 PBKDF2-SHA256,存储格式:pbkdf2$<迭代次数>$<saltBase64>$<hashBase64>
const PBKDF2_PREFIX = 'pbkdf2';
const PBKDF2_DIGEST = 'SHA-256';

// ⚠️ 迭代次数受 Cloudflare Workers 的 CPU 时间预算硬约束,不能照搬 OWASP 的建议值。
// 免费版每个请求只有 10ms CPU 时间,超了直接返回 1102 错误、请求失败。
// 实测(Node/同版本 V8+BoringSSL,Workers 上通常更慢):
//    5,000 次 ≈ 1.1ms     10,000 次 ≈ 5.8ms     100,000 次 ≈ 24.7ms
// 登录请求除了这里还要跑 JWT 校验、D1 查询、i18n 等,所以取 5,000 —— 留足余量,
// 又比原来「单轮 SHA-256」把攻击者的每次猜测成本抬高约三个数量级。
//
// 付费版有 30 秒 CPU 预算,可以放心调到 100000 以上,直接改这个数字即可:
// 存储格式里带着迭代次数,旧哈希仍能按它自己记录的次数校验,调高不会让老用户登不进来。
const PBKDF2_ITERATIONS = 5000;

const saltHashUtils = {

	generateSalt(length = 16) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array));
	},


	async hashPassword(password) {
		const salt = this.generateSalt();
		const hash = await this.genHashPassword(password, salt);
		return { salt, hash };
	},

	async genHashPassword(password, salt) {
		const hashB64 = await this.derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
		return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${salt}$${hashB64}`;
	},

	async verifyPassword(inputPassword, salt, storedHash) {

		if (typeof storedHash !== 'string' || !storedHash) {
			return false;
		}

		// 新格式:pbkdf2$<迭代次数>$<saltBase64>$<hashBase64>
		if (storedHash.startsWith(PBKDF2_PREFIX + '$')) {

			const [, iterations, hashSalt, hashB64] = storedHash.split('$');

			const iterationsNum = Number(iterations);
			const useSalt = hashSalt || salt;

			if (!useSalt || !hashB64 || !Number.isFinite(iterationsNum) || iterationsNum <= 0) {
				return false;
			}

			const hash = await this.derivePbkdf2(inputPassword, useSalt, iterationsNum);
			return timingSafeEqual(hash, hashB64);
		}

		// 兼容旧格式:单轮 SHA-256(salt + password) 的 base64
		const data = encoder.encode(salt + inputPassword);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hash = bytesToBase64(new Uint8Array(hashBuffer));
		return timingSafeEqual(hash, storedHash);
	},

	// 判断是否为旧版(无算法前缀)哈希,用于校验通过后惰性升级
	isLegacyHash(storedHash) {
		return typeof storedHash === 'string'
			&& storedHash.length > 0
			&& !storedHash.startsWith(PBKDF2_PREFIX + '$');
	},

	async derivePbkdf2(password, salt, iterations) {
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(password),
			{ name: 'PBKDF2' },
			false,
			['deriveBits']
		);

		const bits = await crypto.subtle.deriveBits(
			{
				name: 'PBKDF2',
				salt: base64ToBytes(salt),
				iterations: iterations,
				hash: PBKDF2_DIGEST
			},
			key,
			256
		);

		return bytesToBase64(new Uint8Array(bits));
	},

	genRandomPwd(length = 8) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const randomValues = new Uint32Array(length);
		crypto.getRandomValues(randomValues);
		let result = '';
		for (let i = 0; i < length; i++) {
			result += chars.charAt(randomValues[i] % chars.length);
		}
		return result;
	}
};

function base64ToBytes(str) {
	return Uint8Array.from(atob(str), char => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

// 恒定时间字符串比较,避免哈希比对时的时序泄露
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

export default saltHashUtils;
