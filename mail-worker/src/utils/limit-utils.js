import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// 基于 KV 的失败计数 + 锁定,用于认证类接口的暴力破解防护
// 说明:同一窗口内失败达到 MAX_FAIL 次即锁定 LIMIT_WINDOW 秒,计数键通过 expirationTtl 自动过期
const LIMIT_WINDOW = 60 * 15;
const MAX_FAIL = 10;

const limitUtils = {

	// 计数键里带一个「时间片」，形成固定窗口而不是滑动窗口。
	// 滑动窗口的写法（每次失败都重新 put 一遍 TTL）有个便宜的攻击面：
	// 攻击者只要每 14 分钟对一个已知邮箱失败一次，就能把锁定无限续期，
	// 让真正的用户永远登不进来。带上时间片之后，窗口到点自然滚动，
	// 谁也无法延长它。
	key(scope, id) {
		const bucket = Math.floor(Date.now() / (LIMIT_WINDOW * 1000));
		return `limit:${scope}:${id || 'unknown'}:${bucket}`;
	},

	async assertNotLocked(c, scope, id) {
		const count = Number(await c.env.kv.get(this.key(scope, id))) || 0;
		if (count >= MAX_FAIL) {
			throw new BizError(t('tooManyAttempts'), 429);
		}
	},

	async recordFail(c, scope, id) {
		const key = this.key(scope, id);
		const count = (Number(await c.env.kv.get(key)) || 0) + 1;
		// TTL 给两倍窗口，避免在时间片边界上因时钟偏差提前丢计数；
		// 时间片一过 key 自然作废，不需要谁来续期。
		await c.env.kv.put(key, String(count), { expirationTtl: LIMIT_WINDOW * 2 });
		return count;
	},

	async clear(c, scope, id) {
		await c.env.kv.delete(this.key(scope, id));
	}

};

export default limitUtils;
