<template>
  <div class="content-box" ref="contentBox">
    <div ref="container" class="content-html"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import DOMPurify from 'dompurify'

const props = defineProps({
  html: {
    type: String,
    required: true
  }
})

const container = ref(null)
const contentBox = ref(null)
let shadowRoot = null

/**
 * 邮件正文清洗配置。
 *
 * 威胁模型：邮件正文由发件人完全控制，而渲染它的页面持有用户 token。
 * 未清洗时 <img src=x onerror=...> / <svg onload=...> 会在 Shadow DOM 内执行，
 * 等同「谁来一封信就能盗号」。
 *
 * 保留 <style>：邮件普遍依赖它做响应式排版，剥掉会让正文错版。
 * 代价是保留了一点 CSS 注入面，因此在 applyShadowContent 里额外剔除
 * :host 规则（唯一能影响宿主页面的选择器）与 @import。
 */
const PURIFY_CONFIG = {
	ADD_TAGS: ['style', 'center', 'font'],
	ADD_ATTR: ['target', 'bgcolor', 'background', 'align', 'valign', 'border', 'cellpadding', 'cellspacing'],
	FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link', 'frame', 'frameset', 'input', 'button'],
	FORBID_ATTR: ['srcdoc', 'formaction', 'xlink:href'],
	ALLOW_DATA_ATTR: false,
	ALLOW_UNKNOWN_PROTOCOLS: false
	// 刻意不覆盖 ALLOWED_URI_REGEXP：DOMPurify 的默认规则已经做到了
	// data: 只放行 <img>/<video> 等媒体标签，而 <a href="data:text/html"> 会被拦下。
	// 自己写正则很容易把 data: 放行到 href 上，反而开后门。
}

// Shadow DOM 的静态骨架。刻意不做任何字符串插值：
// 旧实现把 <body style="..."> 正则捕获的内容拼进了 <style> 里，
// 发件人只要在 style 里塞 `}</style><img onerror=...>` 就能提前闭合样式标签注入元素。
const SHADOW_SHELL = `
	<style>
		:host {
			all: initial;
			width: 100%;
			height: 100%;
			font-family: Inter, 'Helvetica Neue', Helvetica, 'PingFang SC',
						'Hiragino Sans GB', 'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
			font-size: 14px;
			line-height: 1.5;
			color: #13181D;
			word-break: break-word;
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
		}

		img:not(table img) {
			max-width: 100%;
			height: auto !important;
		}
	</style>
`;

// 只作用在 <body> 上的样式：这些属性能把正文变成覆盖整屏的假界面（点击劫持），剔除掉。
// 颜色/字体/行高这些真正的排版属性保留，否则会改变邮件观感。
const OVERLAY_CSS_PROPS = /(^|;)\s*(position|inset|top|right|bottom|left|z-index|behavior|-moz-binding)\s*:[^;]*/gi;

/**
 * 取出 <body> 上的 style，并交给 DOMPurify 清洗。
 * 不再用字符串拼接写进 <style>，而是作为普通 style 属性挂到容器上 ——
 * 属性值和 CSS 声明列表都是独立的解析上下文，无法越界生成元素。
 */
function extractBodyStyle(rawHtml) {
	try {
		const source = new DOMParser().parseFromString(rawHtml, 'text/html')
		const rawStyle = source.body?.getAttribute('style') || ''
		if (!rawStyle) return ''

		// 借 DOMPurify 走一遍 attribute 清洗（会剔除 expression()、危险 url 协议等）
		const holder = document.createElement('div')
		holder.setAttribute('style', rawStyle)
		const cleaned = DOMPurify.sanitize(holder.outerHTML, {
			ALLOWED_TAGS: [],
			ALLOWED_ATTR: ['style']
		})

		const parsed = document.createElement('div')
		parsed.innerHTML = cleaned
		const style = parsed.firstElementChild?.getAttribute('style') || ''

		return style.replace(OVERLAY_CSS_PROPS, ';')
	} catch {
		return ''
	}
}

/** 剔除邮件自带样式里能影响到宿主页面的部分 */
function sanitizeCss(css) {
	return css
		// @import 会引入外部样式表，绕过本次清洗，同时产生静默网络请求
		.replace(/@import[^;]*;?/gi, '')
		// :host 是 shadow DOM 里唯一能作用到宿主元素的途径
		.replace(/:host\b[^{}]*\{[^{}]*\}/gi, '')
}

function updateContent() {
	if (!shadowRoot) return

	const bodyStyle = extractBodyStyle(props.html)
	// 去掉 body 外壳标签，只留内容（样式已在上面单独取出）
	const inlineHtml = props.html.replace(/<\/?body[^>]*>/gi, '')
	const sanitized = DOMPurify.sanitize(inlineHtml, PURIFY_CONFIG)

	shadowRoot.innerHTML = SHADOW_SHELL

	const content = document.createElement('div')
	content.className = 'shadow-content'
	if (bodyStyle) content.setAttribute('style', bodyStyle)
	content.innerHTML = sanitized

	content.querySelectorAll('style').forEach(styleEl => {
		styleEl.textContent = sanitizeCss(styleEl.textContent || '')
	})

	// 邮件里的链接一律新窗口打开，并带上 noopener，避免把应用本体导航走 / 反向控制页面
	content.querySelectorAll('a[href]').forEach(a => {
		a.setAttribute('target', '_blank')
		a.setAttribute('rel', 'noopener noreferrer nofollow')
	})

	shadowRoot.appendChild(content)
}

function autoScale() {
	if (!shadowRoot || !contentBox.value) return

	const parent = contentBox.value
	const shadowContent = shadowRoot.querySelector('.shadow-content')

	if (!shadowContent) return

	const parentWidth = parent.offsetWidth
	const childWidth = shadowContent.scrollWidth

	if (childWidth === 0) return

	const scale = parentWidth / childWidth

	const hostElement = shadowRoot.host
	hostElement.style.zoom = scale
}

onMounted(() => {
	shadowRoot = container.value.attachShadow({ mode: 'open' })
	updateContent()
	autoScale()
})

onBeforeUnmount(() => {
	if (shadowRoot && shadowRoot.host) {
		shadowRoot.host.style.zoom = ''
	}
	shadowRoot = null
})

watch(() => props.html, () => {
	updateContent()
	autoScale()
})
</script>

<style scoped>
.content-box {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: Inter, "Helvetica Neue", Helvetica, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", Arial, sans-serif;
}

.content-html {
  width: 100%;
  height: 100%;
}
</style>
