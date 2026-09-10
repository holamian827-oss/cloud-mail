/**
 * 登录密码的应用层加密（ECIES：ECDH P-256 + HKDF + AES-GCM）。
 *
 * 解决什么问题：
 *   HTTPS + HSTS 保护的是传输链路。如果访问者的设备上装了抓包代理证书
 *   （Fiddler / Charles 那类根证书），TLS 就被"合法地"解开了，
 *   请求体里的明文密码一览无余。这一层让**即使链路被解开**，
 *   抓包方也只能拿到密文 —— 只有持有私钥的服务端能还原。
 *
 * 边界（不要夸大这层的作用）：
 *   ① 只保护密码这一个字段。登录令牌、邮件内容仍然只靠 TLS。
 *   ② 如果对方能**控制你的设备**（而不只是监听网络），他可以直接改写页面脚本，
 *      在加密之前就把明文拿走 —— 这层挡不住。真正的防护是别在不信任的设备上装证书。
 *
 * 为什么是 ECDH 而不是 RSA（实测数据，别改成 RSA）：
 *   运行时要**自动**生成密钥才能做到零配置，而 RSA-2048 生成一次要 ~64ms，
 *   远超 Workers 免费版每请求 10ms 的 CPU 预算，会把请求直接打成 1102 错误。
 *   ECDH P-256 生成只要 ~0.64ms，每次登录的派生 + 加解密合计也才 ~1.3ms。
 *
 * 零配置设计：
 *   密钥对在**首次使用时自动生成并存入 KV**（只生成一次），不需要任何 secret。
 *   公钥由私钥 JWK 里的 x/y 现场拼出来下发，前端据此加密。
 *   密钥若丢失（KV 被清），会自动重新生成；前端解密失败时提示刷新即可，
 *   刷新后拿到新公钥就恢复正常，不会把用户卡死。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const KV_KEY = 'login_ecdh_keypair';
const CURVE = 'P-256';
const PREFIX = 'ecdh:';
// HKDF 的 info：换掉它等于让新旧密文互不兼容，不要随意改
const HKDF_INFO = 'cloud-mail-login-pwd';

function base64ToBytes(b64) {
	return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

// JWK 里的坐标是 base64url，且没有 padding
function base64UrlToBytes(b64url) {
	let str = b64url.replace(/-/g, '+').replace(/_/g, '/');
	while (str.length % 4) str += '=';
	return base64ToBytes(str);
}

/** 从私钥 JWK 里的 x/y 拼出未压缩的 65 字节公钥点（0x04 || x || y） */
function rawPublicFromJwk(jwk) {
	const x = base64UrlToBytes(jwk.x);
	const y = base64UrlToBytes(jwk.y);
	const out = new Uint8Array(65);
	out[0] = 4;
	out.set(x, 1);
	out.set(y, 33);
	return out;
}

const eciesUtils = {

	/**
	 * 取出密钥对（没有就生成一把并写入 KV）。
	 * 生成成功率高、开销小，所以放在请求路径上是安全的（见文件头的实测数据）。
	 */
	async ensurePrivateJwk(c) {

		if (!c?.env?.kv) {
			return null;
		}

		const stored = await c.env.kv.get(KV_KEY, { type: 'json' });

		if (stored?.d) {
			return stored;
		}

		const pair = await crypto.subtle.generateKey(
			{ name: 'ECDH', namedCurve: CURVE },
			true,
			['deriveBits']
		);

		const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

		// 无 TTL：密钥要长期稳定，否则每次过期都会让在途的登录失败
		await c.env.kv.put(KV_KEY, JSON.stringify(jwk));

		return jwk;
	},

	async importPrivateKey(c) {

		const jwk = await this.ensurePrivateJwk(c);

		if (!jwk) {
			return null;
		}

		return crypto.subtle.importKey(
			'jwk',
			jwk,
			{ name: 'ECDH', namedCurve: CURVE },
			false,
			['deriveBits']
		);
	},

	/** 下发给前端的公钥（未压缩点，标准 base64）。任何异常都返回 null 以便走明文回退 */
	async publicKeyBase64(c) {

		try {
			const jwk = await this.ensurePrivateJwk(c);

			if (!jwk) {
				return null;
			}

			return bytesToBase64(rawPublicFromJwk(jwk));
		} catch (e) {
			console.error('生成登录加密密钥失败，已回退为明文密码', e);
			return null;
		}
	},

	/** 前端密文以 "ecdh:" 前缀标识，明文密码不受影响 */
	isEncrypted(value) {
		return typeof value === 'string' && value.startsWith(PREFIX);
	},

	/** 解密失败返回 null，由调用方决定怎么报错 */
	async decrypt(c, value) {

		try {
			const payload = JSON.parse(atob(value.slice(PREFIX.length)));

			const privateKey = await this.importPrivateKey(c);

			if (!privateKey || !payload?.k || !payload?.i || !payload?.d) {
				return null;
			}

			const ephemeralPublic = await crypto.subtle.importKey(
				'raw',
				base64ToBytes(payload.k),
				{ name: 'ECDH', namedCurve: CURVE },
				false,
				[]
			);

			// 双方各自算出的共享密钥相同：客户端用临时私钥 + 服务端公钥，
			// 服务端用长期私钥 + 客户端临时公钥
			const sharedBits = await crypto.subtle.deriveBits(
				{ name: 'ECDH', public: ephemeralPublic },
				privateKey,
				256
			);

			const iv = base64ToBytes(payload.i);

			const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

			// 用 iv 当盐：把密文和它的 iv 绑定在一起
			const aesKey = await crypto.subtle.deriveKey(
				{ name: 'HKDF', hash: 'SHA-256', salt: iv, info: encoder.encode(HKDF_INFO) },
				hkdfKey,
				{ name: 'AES-GCM', length: 256 },
				false,
				['decrypt']
			);

			const plain = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv },
				aesKey,
				base64ToBytes(payload.d)
			);

			return decoder.decode(plain);
		} catch (e) {
			return null;
		}
	}

}

export default eciesUtils
