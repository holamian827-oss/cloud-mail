/**
 * 用服务端下发的公钥加密密码（ECIES：ECDH P-256 + HKDF + AES-GCM），提交时带 "ecdh:" 前缀。
 *
 * 解决什么问题：
 *   HTTPS + HSTS 保护的是传输链路。但如果访问者的设备上装了抓包代理证书
 *   （Fiddler / Charles 那类根证书），TLS 就被"合法地"解开了，请求体里的
 *   明文密码一览无余。加密之后，抓包方只能拿到密文。
 *
 * 边界（不要夸大这层的作用）：
 *   ① 只保护密码这一个字段。登录令牌、邮件内容仍然只靠 TLS。
 *   ② 如果对方能**控制你的设备**（而不只是监听网络），他可以直接改写页面脚本，
 *      在加密之前把明文拿走 —— 这层挡不住。真正的防护是别在不信任的设备上装证书。
 *
 * 每次都用一把临时密钥做 ECDH：除了算出共享密钥，还有**前向保密** ——
 * 即使服务端的长期私钥日后泄露，也解不开之前抓到的密文。
 *
 * 本文件刻意分成两层：
 *   encryptWithPublicKey —— 纯函数，不依赖任何 store，可以直接在 Node 里跑测试；
 *   encryptPassword       —— 负责取配置的那一层。
 * 把 store 依赖隔离在下面那一层，测试才能验证**真实代码**而不是它的副本。
 */

const PREFIX = 'ecdh:';
const CURVE = 'P-256';
// 与服务端 crypto-ecies.js 保持一致，改了会互相解不开
const HKDF_INFO = 'cloud-mail-login-pwd';

function base64ToBytes(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/**
 * 纯加密逻辑：给定服务端公钥（未压缩点，base64），返回可直接提交的密文串。
 * 加密失败时**原样返回明文** —— 由 HTTPS 兜底，绝不因为加密出错让人登不进来。
 */
export async function encryptWithPublicKey(publicKeyBase64, password) {

    if (!password || !publicKeyBase64) {
        return password;
    }

    try {
        const serverPublic = await crypto.subtle.importKey(
            'raw',
            base64ToBytes(publicKeyBase64),
            { name: 'ECDH', namedCurve: CURVE },
            false,
            []
        );

        // 一次一密：临时密钥对，用完即弃
        const ephemeral = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: CURVE },
            true,
            ['deriveBits']
        );

        const sharedBits = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: serverPublic },
            ephemeral.privateKey,
            256
        );

        const iv = crypto.getRandomValues(new Uint8Array(12));

        const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

        const aesKey = await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: iv, info: new TextEncoder().encode(HKDF_INFO) },
            hkdfKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt']
        );

        const cipherText = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            new TextEncoder().encode(password)
        );

        const ephemeralPublicRaw = await crypto.subtle.exportKey('raw', ephemeral.publicKey);

        // payload 全是 base64 字符串，纯 ASCII，btoa 安全
        return PREFIX + btoa(JSON.stringify({
            k: bytesToBase64(ephemeralPublicRaw),
            i: bytesToBase64(iv),
            d: bytesToBase64(cipherText)
        }));
    } catch (e) {
        console.warn('密码加密失败，已回退为明文传输（仍由 HTTPS 保护）', e);
        return password;
    }
}

/**
 * 供业务调用：从配置里取公钥再加密。
 * 服务端没给出公钥（未启用该层）时原样返回明文。
 */
export async function encryptPassword(password) {

    if (!password) {
        return password;
    }

    // 动态导入：让纯函数那一层保持零依赖，Node 里可以直接 import 做互操作测试
    const { useSettingStore } = await import('@/store/setting.js');
    const publicKeyBase64 = useSettingStore().settings.loginPubKey;

    if (!publicKeyBase64) {
        return password;
    }

    return encryptWithPublicKey(publicKeyBase64, password);
}

export default encryptPassword;
