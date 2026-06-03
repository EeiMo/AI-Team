/**
 * src/middleware/auth.ts
 * 职责：飞书 SSO 认证中间件
 *      - 从 Authorization header 提取 Bearer token
 *      - Token 类型自动识别：JWT → 飞书 user_access_token
 *      - 注入 req.user = { user_id, team_id, display_name }
 *
 * Token 验证顺序：
 * 1. 尝试 JWT 验证（若 JWT_SECRET 已配置）
 * 2. 调用飞书 /open-apis/authen/v1/user_info 验签（生产）
 * 3. 回退降级解析（仅开发/测试环境）
 *
 * 注意：JWT_SECRET 和飞书凭证在运行时从 process.env 读取，
 * 确保测试中设置环境变量后能生效。config 模块仅在启动时求值，
 * 运行时 set env 不会影响已缓存的 config 对象。
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

/** JWT payload 结构 */
interface JwtUserPayload {
  user_id: string;
  team_id: string;
  display_name: string;
  iat?: number;
  exp?: number;
}

/**
 * 统一 Token 验证入口。
 *
 * 按优先级尝试：JWT → 飞书 API → 降级
 *
 * 从 process.env 读取 JWT_SECRET / FEISHU 凭证，确保运行时设置的环境变量生效。
 */
export async function verifyFeishuToken(token: string): Promise<{
  user_id: string;
  team_id: string;
  display_name: string;
}> {
  // --- 1. 尝试 JWT 验证 ---
  const jwtSecret = config.JWT_SECRET || process.env.JWT_SECRET;
  if (jwtSecret) {
    try {
      const decoded = jwt.verify(token, jwtSecret) as JwtUserPayload;
      if (decoded.user_id) {
        return {
          user_id: decoded.user_id,
          team_id: decoded.team_id || '',
          display_name: decoded.display_name || decoded.user_id,
        };
      }
    } catch (jwtErr: any) {
      // JWT 验证失败非致命，继续尝试飞书 API
      if (jwtErr.name === 'TokenExpiredError') {
        throw new Error('JWT 已过期，请重新登录');
      }
      // 其他 JWT 错误（格式不正确等）→ 继续尝试飞书 API
    }
  }

  // --- 2. 生产模式：调用飞书 Open API 验证 user_access_token ---
  const feishuAppId = config.FEISHU_APP_ID || process.env.FEISHU_APP_ID;
  const feishuAppSecret = config.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET;
  if (feishuAppId && feishuAppSecret) {
    try {
      const res = await fetch(
        `https://open.feishu.cn/open-apis/authen/v1/user_info`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const body = await res.json() as any;
        const user = body?.data;
        if (user) {
          return {
            user_id: user.open_id || user.user_id,
            team_id: user.tenant_key || '',
            display_name: user.name || user.en_name || user.open_id,
          };
        }
      }
    } catch {
      // 飞书 API 不可用时继续降级
    }
  }

  // --- 3. 降级：直接解析 token（仅开发/测试环境）---
  // 优先使用运行时 process.env.NODE_ENV（config 缓存的可能在测试中不准确）
  const nodeEnv = process.env.NODE_ENV || config.NODE_ENV || 'development';
  if (nodeEnv !== 'production') {
    return {
      user_id: token.substring(0, 64),
      team_id: config.TEAM_TOTAL_MEMBERS > 0 ? 'env_team' : 'unknown',
      display_name: token.substring(0, 32),
    };
  }

  throw new Error('Token 验证失败');
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
