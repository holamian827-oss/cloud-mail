import i18next from 'i18next';
import zh from './zh.js'
import en from './en.js'
import app from '../hono/hono';

const resources = {
	en: {
		translation: en
	},
	zh: {
		translation: zh,
	},
};

// 全局只初始化一次：原来每个请求都 init 一遍，既浪费又会让资源和语言状态
// 被并发请求反复重置。
//
// ⚠️ 已知残余问题（没有解决，也不打算用注释假装解决）：
// 语言仍然挂在 isolate 级可变单例上。同一个 isolate 里两个并发请求若带不同的
// accept-language，后到的 changeLanguage 会覆盖先到的，导致先到的那个请求在
// 后续 await 之后拿错语言。彻底解决需要把语言做成请求级上下文，而 t() 拿不到
// 请求对象（调用点太多，改造成本远超收益）。
// 实际影响可控：前端每个请求都会带 accept-language，同一用户的语言是稳定的，
// 只有同一 isolate 内跨用户并发不同语言时才会偶发串语言。
i18next.init({
	fallbackLng: 'zh',
	resources,
});

app.use('*', async (c, next) => {
	// 没有 accept-language 时要显式回落到默认语言。
	// 否则会沿用上一个请求留下的语言 —— 语言现在挂在 isolate 级单例上，
	// 「不指定」不等于「默认」，而等于「上一个人用的」。
	const lang = c.req.header('accept-language')?.split('-')[0] || 'zh'

	// 已初始化完成，这里只切换语言，并等待切换完成后再进入业务逻辑
	if (i18next.language !== lang) {
		await i18next.changeLanguage(lang);
	}

	return await next()
})

export const t = (key, values) => i18next.t(key, values)

export default i18next;
