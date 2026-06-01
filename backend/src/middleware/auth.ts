/**
 * src/middleware/auth.ts
 * 职责：飞书 SSO 认证中间件
 *      - 从 Authorization header 提取 Bearer token
 *      - 调用飞书 /open-apis/authen/v1/user_info 验签（生产）
 *      - 开发环境回退 dev token 模式
 *      - 注入 req.user = { user_id, team_id, display_name }
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

const DEV_TOKEN_PREFIX = 'dev_';

/**
 * 飞书 SSO 验签。生产环境调用飞书 Open API。
 */
export async function verifyFeishuToken(token: string): Promise<{
  user_id: string;
  team_id: string;
  display_name: string;
}> {
  // --- 生产模式：调用飞书 Open API ---
  if (config.NODE_ENV === 'production' && config.FEISHU_APP_ID && config.FEISHU_APP_SECRET) {
    const appAccessToken = await getAppAccessToken();
    const userAccessToken = await getUserAccessToken(token, appAccessToken);
    const res = await fetch(
      `https://open.feishu.cn/open-apis/authen/v1/user_info`,
      { headers: { Authorization: `Bearer ${userAccessToken}` } }
    );
    if (!res.ok) throw new Error('Feishu SSO 验签失败');
    const body = await res.json() as any;
    const user = body?.data;
    if (!user) throw new Error('Feishu SSO 返回数据异常');
    return {
      user_id: user.open_id || user.user_id,
      team_id: user.tenant_key || '',
      display_name: user.name || user.en_name || user.open_id,
    };
  }

  // --- 开发模式：dev 令牌格式 dev_userId_teamId_displayName ---
  if (token.startsWith(DEV_TOKEN_PREFIX)) {
    const parts = token.slice(DEV_TOKEN_PREFIX.length).split('_');
    return {
      user_id: parts[0] || 'ou_dev_user_001',
      team_id: parts[1] || 'dev_team_001',
      display_name: parts[2] || '开发用户',
    };
  }

  // 非 dev 环境下无飞书凭证，降级解析 token 为 user_id
  return {
    user_id: token.substring(0, 64),
    team_id: config.TEAM_TOTAL_MEMBERS > 0 ? 'env_team' : 'unknown',
    display_name: token.substring(0, 32),
  };
}

/** 获取飞书应用 access_token（缓存 1.5h） */
let _cachedAppToken: { token: string; expires: number } | null = null;

async function getAppAccessToken(): Promise<string> {
  if (_cachedAppToken && Date.now() < _cachedAppToken.expires) {
    return _cachedAppToken.token;
  }
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.FEISHU_APP_ID, app_secret: config.FEISHU_APP_SECRET }),
  });
  if (!res.ok) throw new Error('获取飞书 app_access_token 失败');
  const body = await res.json() as any;
  _cachedAppToken = {
    token: body.app_access_token,
    expires: Date.now() + (body.expire || 7200) * 1000 - 600_000, // 提前 10 分钟刷新
  };
  return _cachedAppToken.token;
}

/** 用 user_access_token 换取 user_info */
async function getUserAccessToken(code: string, appAccessToken: string): Promise<string> {
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${appAccessToken}`,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
    }),
  });
  if (!res.ok) throw new Error('换取 user_access_token 失败');
  const body = await res.json() as any;
  return body.data?.access_token || body.access_token;
}

/**
 * 飞书 SSO 认证中间件工厂。
 * 用法：app.use(feishuAuth({ FEISHU_APP_ID: '...', FEISHU_APP_SECRET: '...' }))
 */
export function feishuAuth(_opts: {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
} = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      res.status(401).json({ code: 40100, message: '未登录或登录已过期，请重新登录' });
      return;
    }

    try {
      const user = await verifyFeishuToken(token);
      req.user = {
        user_id: user.user_id,
        team_id: user.team_id,
        display_name: user.display_name,
      };
      next();
    } catch (err) {
      console.error('[Auth] 飞书 SSO 验签失败:', err);
      res.status(401).json({ code: 40100, message: '未登录或登录已过期，请重新登录' });
    }
  };
}
