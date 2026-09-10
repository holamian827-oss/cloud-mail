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

// 全局只初始化一次，避免每个请求都 init 导致资源/语言被并发请求互相覆盖
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
