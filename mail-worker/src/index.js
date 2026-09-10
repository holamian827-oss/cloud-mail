import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		// SEO：robots.txt 与 sitemap.xml 按**请求的域名**动态生成。
		// 写成静态文件的话，sitemap 里的绝对地址就得跟着部署域名手工改，
		// 换域名/多域名部署时极易漏改 —— 而 sitemap 里地址写错，
		// 搜索引擎会判定整份 sitemap 无效。
		if (url.pathname === '/robots.txt') {
			return new Response(
				[
					'User-agent: *',
					'Allow: /',
					// 接口没有收录价值，别浪费抓取预算
					'Disallow: /api/',
					'',
					`Sitemap: ${url.origin}/sitemap.xml`,
					''
				].join('\n'),
				{ headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
			);
		}

		if (url.pathname === '/sitemap.xml') {
			// 只登记介绍页。邮件应用本体（登录/收件箱）是登录后才可见的功能界面，
			// 没有收录价值，而且放出去等于把注册入口交给爬虫，所以那边设了 noindex。
			const lastmod = new Date().toISOString().slice(0, 10);

			return new Response(
				[
					'<?xml version="1.0" encoding="UTF-8"?>',
					'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
					'  <url>',
					`    <loc>${url.origin}/about</loc>`,
					`    <lastmod>${lastmod}</lastmod>`,
					'    <changefreq>monthly</changefreq>',
					'    <priority>1.0</priority>',
					'  </url>',
					'</urlset>',
					''
				].join('\n'),
				{ headers: { 'Content-Type': 'application/xml; charset=utf-8' } }
			);
		}

		// 介绍页的干净地址 /about **刻意不在这里做重写**。
		//
		// 静态资源层的默认 html_handling（auto-trailing-slash）本来就提供这两个行为：
		//     /about       → 200，返回 dist/about.html
		//     /about.html  → 307 跳转到 /about
		// 也就是说「无扩展名地址 + 扩展名收敛」平台已经做好了。
		//
		// 曾经这里手写过一遍，结果造成了无限重定向：
		//   浏览器请求 /about → 这里重写成 /about.html 交给资源层 →
		//   资源层按上面的规则把它 307 跳回 /about → 又回到这里……
		// 教训：不要重复实现平台已有的路由行为，尤其是会自我引用的那种。
		// 需要 /about 生效，只要保证 public/about.html 存在即可。

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await kvObjService.toObjResp( { env }, url.pathname.substring(1));
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};
