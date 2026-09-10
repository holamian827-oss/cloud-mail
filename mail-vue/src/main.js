import {createApp} from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { init } from '@/init/init.js';
import { createPinia } from 'pinia';
import piniaPersistedState from 'pinia-plugin-persistedstate';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'nprogress/nprogress.css';
// 磨砂玻璃主题层：必须放在 style.css 与 element-plus 的 css-vars 之后
import './style/glass.css';
import perm from "@/perm/perm.js";
import { initPointer3d } from "@/utils/pointer-3d.js";
const pinia = createPinia().use(piniaPersistedState)
import i18n from "@/i18n/index.js";
const app = createApp(App).use(pinia)
await init()
app.use(router).use(i18n).directive('perm',perm)
app.config.devtools = import.meta.env.DEV;

// 3D 视差：只挂一个全局指针监听，位置写进 CSS 变量供主题层使用
initPointer3d();

app.mount('#app');
