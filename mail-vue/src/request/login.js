import http from '@/axios/index.js';

// token：密码连续输错到阈值后，后端要求附带人机验证 token（见 views/login 的 430 处理）
export function login(email, password, token) {
    return http.post('/login', {email: email, password: password, token: token})
}

export function logout() {
    return http.delete('/logout')
}

export function register(form) {
    return http.post('/register', form)
}