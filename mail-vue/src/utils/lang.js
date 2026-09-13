import {useSettingStore} from '@/store/setting.js'
import {setExtend} from '@/utils/day.js'

/**
 * 应用语言（界面文案）—— 统一从这里改，别在各组件里各自 set。
 *
 * 语言状态挂在 settingStore.lang 上，并且已经持久化（store 的 persist 只挑 lang），
 * 所以「记住用户选择」是自动的。改语言会连锁触发三处：
 *   1. App.vue 的 watch 把 vue-i18n 的 locale 切过去（页面文案）
 *   2. axios 拦截器读 lang 设置 accept-language（后端返回对应语言的错误提示）
 *   3. setExtend 把 dayjs 的相对时间文案切过去（"几分钟前" / "3 minutes ago"）
 */
export function applyLang(lang) {
    setExtend(lang === 'en' ? 'en' : 'zh-cn')
    useSettingStore().lang = lang
}

/** 在中文 / 英文之间来回切 */
export function toggleLang() {
    const store = useSettingStore()
    applyLang(store.lang === 'en' ? 'zh' : 'en')
}
