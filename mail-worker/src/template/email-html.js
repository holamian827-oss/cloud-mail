import { parseHTML } from 'linkedom';
import domainUtils from '../utils/domain-uitls';

// 整段移除的危险标签
const FORBIDDEN_TAGS = ['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'form', 'meta'];
// 需要校验协议的属性
const URL_ATTRS = ['href', 'xlink:href', 'src', 'action', 'formaction', 'background', 'poster', 'data', 'srcdoc'];
// 链接类属性,连 data: 协议一并拒绝
const HREF_ATTRS = ['href', 'xlink:href', 'action', 'formaction', 'srcdoc'];
// 危险协议(javascript: / vbscript: / data:text/html)
const DANGEROUS_PROTOCOL = /^(javascript|vbscript):|^data:text\/html/i;

export default function emailHtmlTemplate(html, domain) {

	const { document } = parseHTML(html);

	// 清洗邮件HTML:移除危险标签、on* 事件属性与危险协议,防止存储型XSS
	document.querySelectorAll(FORBIDDEN_TAGS.join(',')).forEach(el => el.remove());

	document.querySelectorAll('*').forEach(el => {

		Array.from(el.attributes).forEach(attr => {

			const name = attr.name.toLowerCase();

			// 移除所有 on* 事件属性
			if (name.startsWith('on')) {
				el.removeAttribute(attr.name);
				return;
			}

			if (!URL_ATTRS.includes(name) && !name.endsWith(':href')) {
				return;
			}

			// 去掉空白/控制字符(charCode <= 32),避免 javascript: 被拆分绕过
			const value = [...(attr.value || '')].filter(ch => ch.charCodeAt(0) > 32).join('');

			if (DANGEROUS_PROTOCOL.test(value) || (HREF_ATTRS.includes(name) && /^data:/i.test(value))) {
				el.removeAttribute(attr.name);
			}

		});

	});

	html = document.toString();
	html = html.replace(/{{domain}}/g, domainUtils.toOssDomain(domain) + '/');
	const safeHtmlJson = JSON.stringify(html).replace(/</g, '\\u003C');

	return `<!DOCTYPE html>
<html lang='en' >
<head>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1.0'>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            background: #FFF;
        }

        .content-box {
        		padding: 15px 10px;
            width: 100%;
            height: 100%;
            overflow: auto; /* 改为 auto 允许滚动 */
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .content-html {
            width: 100%;
            height: 100%;
        }
    </style>
</head>
<body>
    <div class='content-box'>
        <div id='container' class='content-html'></div>
    </div>

    <script>

        function renderHTML(html) {
            const container = document.getElementById('container');
            const shadowRoot = container.attachShadow({ mode: 'open' });

            // 提取 <body> 的 style 属性
            const bodyStyleRegex = /<body[^>]*style="([^"]*)"[^>]*>/i;
            const bodyStyleMatch = html.match(bodyStyleRegex);
            const bodyStyle = bodyStyleMatch ? bodyStyleMatch[1] : '';

            // 移除 <body> 标签
            const cleanedHtml = html.replace(/<\\/?body[^>]*>/gi, '');

            // 渲染内容
            shadowRoot.innerHTML = \`
                <style>
                    :host {
                        all: initial;
                        width: 100%;
                        height: 100%;
                        font-family: Inter, -apple-system, BlinkMacSystemFont,
                                    'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        font-size: 14px;
                        line-height: 1.5;
                        color: #13181D;
                        word-break: break-word;
                        overflow: auto; /* 添加滚动 */
                    }

                    h1, h2, h3, h4 {
                        font-size: 18px;
                        font-weight: 700;
                    }

                    p {
                        margin: 0;
                    }

                    a {
                        text-decoration: none;
                        color: #0E70DF;
                    }

                    .shadow-content {
                        background: #FFFFFF;
                        width: fit-content;
                        height: fit-content;
                        min-width: 100%;
                        \${bodyStyle ? bodyStyle : ''} /* 注入 body 的 style */
                    }

                    img:not(table img) {
                        max-width: 100% !important;
                        height: auto !important;
                    }
                </style>
                <div class="shadow-content">
                    \${cleanedHtml}
                </div>
            \`;

            // 自动缩放
            autoScale(shadowRoot, container);
        }

        function autoScale(shadowRoot, container) {

            if (!shadowRoot || !container) return;

            const parent = container;
            const shadowContent = shadowRoot.querySelector('.shadow-content');

            if (!shadowContent) return;

            const parentWidth = parent.offsetWidth;
            const childWidth = shadowContent.scrollWidth;

            if (childWidth === 0) return;

            const scale = parentWidth / childWidth;

            const hostElement = shadowRoot.host;
            hostElement.style.zoom = scale;
        }

        // 使用示例
        const exampleHtml = ${safeHtmlJson};

        // 渲染HTML
        renderHTML(exampleHtml);
    </script>
</body>
</html>`
}
