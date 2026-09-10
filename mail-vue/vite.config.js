import {defineConfig, loadEnv} from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import {ElementPlusResolver} from 'unplugin-vue-components/resolvers'
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), 'VITE')
    return {
        server: {
            host: true,
            port: 3001,
            hmr: true,
        },
        base: env.VITE_STATIC_URL || '/',
        plugins: [vue(),
            VitePWA({
                injectRegister: 'script-defer',
                manifest: {
                    name: env.VITE_PWA_NAME,
                    short_name: env.VITE_PWA_NAME,
                    background_color: '#FFFFFF',
                    theme_color: '#FFFFFF',
                    icons: [
                        {
                            src: 'mail-pwa.png',
                            sizes: '192x192',
                            type: 'image/png',
                        },
                        {
                            src: 'mail-pwa-512.png',
                            sizes: '512x512',
                            type: 'image/png',
                        }
                    ],
                },
                workbox: {
                    disableDevLogs: true,
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
                    // tinymce 体积较大(约 4.5M)，不参与预缓存，改为运行时缓存
                    globIgnores: ['**/tinymce/**'],
                    // history 路由：非 /api 的导航请求回退到 index.html
                    navigateFallback: 'index.html',
                    navigateFallbackDenylist: [/^\/api/],
                    runtimeCaching: [
                        {
                            urlPattern: /\/tinymce\/.*\.(?:js|css|woff2?|svg|png|gif)$/,
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'tinymce-assets',
                                expiration: {
                                    maxEntries: 300,
                                    maxAgeSeconds: 60 * 60 * 24 * 30
                                }
                            }
                        }
                    ],
                    cleanupOutdatedCaches: true,
                }
            }),
            AutoImport({
                resolvers: [ElementPlusResolver()],
            }),
            Components({
                resolvers: [ElementPlusResolver()],
            })
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, 'src')
            }
        },
        build: {
            target: 'es2022',
            outDir: env.VITE_OUT_DIR || 'dist',
            emptyOutDir: true,
            assetsInclude: ['**/*.json']
        }
    }
})
