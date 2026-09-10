/**
 * 全局指针追踪，用于 3D 视差。
 *
 * 架构约定：
 * 只挂一个 pointermove 监听，把鼠标位置归一化到 [-1, 1] 后写进 :root 的
 * --pointer-x / --pointer-y。所有需要 3D 视差的元素在 CSS 里直接引用这两个
 * 变量即可（见 style/glass.css 的「3D 动效」一节）。
 *
 * 为什么不给每个组件各挂一个监听：
 *   - 本应用有虚拟列表和大量卡片，逐元素挂监听会让指针移动变成 O(n) 次回调；
 *   - 位置写在一个变量上，浏览器只需重算一次样式，天然同步、不会互相打架。
 *
 * 为什么不用 Three.js / WebGL：
 *   仅为几个视差和倾斜引入 3D 引擎，会给这个以首屏体积和滚动流畅度为生命线的
 *   邮件客户端增加几百 KB 和持续的渲染开销，收益与代价完全不匹配。
 *   CSS 的 transform 走 GPU 合成层，零依赖、零 JS 逐帧计算。
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
// 阻尼系数：越小跟得越慢越"重"，3D 倾斜要的就是这种迟滞感
const EASING = 0.12
const SETTLE = 0.0008

let targetX = 0
let targetY = 0
let currentX = 0
let currentY = 0
let rafId = null
let started = false

function writeVars() {
	const root = document.documentElement
	root.style.setProperty('--pointer-x', currentX.toFixed(4))
	root.style.setProperty('--pointer-y', currentY.toFixed(4))
}

function tick() {
	currentX += (targetX - currentX) * EASING
	currentY += (targetY - currentY) * EASING

	if (Math.abs(targetX - currentX) < SETTLE && Math.abs(targetY - currentY) < SETTLE) {
		currentX = targetX
		currentY = targetY
		writeVars()
		rafId = null
		return
	}

	writeVars()
	rafId = requestAnimationFrame(tick)
}

function wake() {
	if (rafId === null) {
		rafId = requestAnimationFrame(tick)
	}
}

function onPointerMove(event) {
	// 归一化到 [-1, 1]：屏幕中心是 0，左上角是 (-1, -1)
	targetX = (event.clientX / window.innerWidth) * 2 - 1
	targetY = (event.clientY / window.innerHeight) * 2 - 1
	wake()
}

function onPointerLeave() {
	// 指针离开窗口时回到中位，避免元素停在倾斜状态
	targetX = 0
	targetY = 0
	wake()
}

export function initPointer3d() {
	if (started) {
		return
	}

	// 触摸设备没有"指针悬停"这回事，减少动效偏好也不该被无视
	if (window.matchMedia('(pointer: coarse)').matches) {
		return
	}
	if (window.matchMedia(REDUCED_MOTION).matches) {
		return
	}

	started = true
	// passive：这个监听永远不会 preventDefault，声明后滚动不会被它阻塞
	window.addEventListener('pointermove', onPointerMove, { passive: true })
	// 挂在 documentElement 而不是 document：pointerleave 不冒泡，
	// 挂在根元素上才收得到"指针离开窗口"这个事件。
	document.documentElement.addEventListener('pointerleave', onPointerLeave, { passive: true })
	writeVars()
}

export default initPointer3d
