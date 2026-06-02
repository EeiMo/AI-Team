/**
 * services/api.ts
 * Axios 实例 + 拦截器：baseURL、Authorization 注入、401 处理、统一错误格式化
 */
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { ApiResponse } from '../types';

// ---- Axios 实例 ----
const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ---- 请求拦截器：注入飞书 SSO token ----
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // MVP: 从 localStorage 读取 token（飞书 SSO 注入的 bearer token）
    const token = localStorage.getItem('feishu_token');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error)
);

// ---- 响应拦截器：统一错误处理 ----
api.interceptors.response.use(
  (response) => {
    const body = response.data as ApiResponse;
    if (body.code !== 0) {
      // 业务错误码非 0，抛出统一异常
      return Promise.reject(new ApiError(body.code, body.message ?? '未知错误', body.detail));
    }
    return response;
  },
  (error: AxiosError<ApiResponse>) => {
    if (error.response) {
      const { status, data } = error.response;
      switch (status) {
        case 401:
          // 未认证 → 清除 token 并提示重新登录
          localStorage.removeItem('feishu_token');
          console.warn('[API] 401 — 未登录或 token 过期');
          break;
        case 429: {
          const retryAfter = error.response.headers['retry-after'];
          console.warn(`[API] 429 — 限流，${retryAfter ? retryAfter + 's 后重试' : '请稍后'}`);
          break;
        }
        default:
          break;
      }
      // 优先使用后端返回的 code/message
      if (data?.code) {
        return Promise.reject(new ApiError(data.code, data.message ?? '请求失败', data.detail));
      }
    }
    if (error.code === 'ECONNABORTED') {
      return Promise.reject(new ApiError(-1, '请求超时，请检查网络'));
    }
    return Promise.reject(new ApiError(-1, '网络异常，请稍后重试'));
  }
);

// ---- 自定义 API 错误类 ----
export class ApiError extends Error {
  code: number;
  detail?: string;

  constructor(code: number, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

// ---- 飞书 SSO 认证 API ----
export interface FeishuAuthResponse {
  token: string;
  user_id: string;
  display_name: string;
  avatar_url?: string;
}

/** 获取飞书 SSO 跳转 URL（备用：直接返回 redirect_uri，前端负责跳转） */
export async function getFeishuRedirectUrl(): Promise<string> {
  const res = await api.get<ApiResponse<{ redirect_url: string }>>('/auth/feishu/redirect-url');
  return res.data.data!.redirect_url;
}

/** 飞书 OAuth 回调：用 code 换取 token + 用户信息 */
export async function feishuCallback(code: string, state: string): Promise<FeishuAuthResponse> {
  const res = await api.get<ApiResponse<FeishuAuthResponse>>('/auth/feishu/callback', {
    params: { code, state },
  });
  return res.data.data!;
}

/** 校验 token 有效性 */
export async function verifyToken(): Promise<{ user_id: string; display_name: string }> {
  const res = await api.get<ApiResponse<{ user_id: string; display_name: string }>>('/auth/verify');
  return res.data.data!;
}

export default api;
export { api };
