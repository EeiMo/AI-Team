/**
 * src/routes/auth.ts
 * 职责：飞书 SSO 认证路由
 *      - GET /api/auth/feishu/redirect → 构造飞书 OAuth 授权页 URL
 *      - GET /api/auth/feishu/callback  → 接收飞书回调 code，换取 token，签发 JWT
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import Redis from 'ioredis';
import { knex } from '../db/knex';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { verifyFeishuToken } from '../middleware/auth';

// ---- 常量 ----

/** 飞书 API 最大重试次数 */
const MAX_RETRIES = 3;

/** 重试间隔基数（毫秒） */
const RETRY_BASE_MS = 500;

/** dev token 前缀 */
const DEV_TOKEN_PREFIX = 'dev_';

// ============================================================
// 工具函数
// ============================================================

/** 生成随机 state（CSRF 防护） */
function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** 指数退避等待 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的 fetch 封装（飞书 API 调用）
 * 仅对 5xx / 429 / 网络错误重试；4xx 不重试
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = MAX_RETRIES
): Promise<globalThis.Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 注意：用 fetchRes 避免与 Express Response 类型冲突
      const fetchRes: globalThis.Response = await fetch(url, options);

      // 4xx 不重试（客户端错误）
      if (fetchRes.status >= 400 && fetchRes.status < 500 && fetchRes.status !== 429) {
        return fetchRes;
      }

      // 成功或 429 用完本次尝试
      if (fetchRes.ok || fetchRes.status === 429) {
        return fetchRes;
      }

      // 5xx → 重试
      lastError = new Error(`HTTP ${fetchRes.status}`);
    } catch (err: any) {
      lastError = err;
    }

    // 指数退避
    if (attempt < maxRetries - 1) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError || new Error('飞书 API 请求失败（已达最大重试次数）');
}

// ============================================================
// 飞书 API 调用
// ============================================================

/**
 * 获取飞书 app_access_token（复用 auth.ts 逻辑，独立缓存）
 * 注意：此处使用独立的模块级缓存，与 middleware/auth.ts 不共享
 */
let _cachedAppToken: { token: string; expires: number } | null = null;

async function getAppAccessToken(): Promise<string> {
  if (!config.FEISHU_APP_ID || !config.FEISHU_APP_SECRET) {
    throw new AppError(50001, '飞书应用凭证未配置', '请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  }

  if (_cachedAppToken && Date.now() < _cachedAppToken.expires) {
    return _cachedAppToken.token;
  }

  const resp = await fetchWithRetry(
    'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.FEISHU_APP_ID,
        app_secret: config.FEISHU_APP_SECRET,
      }),
    }
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new AppError(50002, '获取飞书 app_access_token 失败', `HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const body = await resp.json() as any;
  if (!body.app_access_token) {
    throw new AppError(50002, '飞书返回数据异常', '缺少 app_access_token');
  }

  _cachedAppToken = {
    token: body.app_access_token,
    expires: Date.now() + (body.expire || 7200) * 1000 - 600_000, // 提前 10 分钟刷新
  };
  return _cachedAppToken.token;
}

/**
 * 用 authorization_code 换取 user_access_token
 */
async function exchangeCodeForToken(code: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  // 获取 app_access_token
  let appAccessToken: string;
  try {
    appAccessToken = await getAppAccessToken();
  } catch (err) {
    throw err;
  }

  const resp = await fetchWithRetry(
    'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appAccessToken}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    }
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new AppError(40100, '飞书授权码无效或已过期', `HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const body = await resp.json() as any;
  const data = body?.data || body;

  if (!data?.access_token) {
    throw new AppError(50002, '飞书 token 响应异常', '缺少 access_token');
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 7200,
  };
}

/**
 * 用 user_access_token 获取用户信息
 */
async function getUserInfo(userAccessToken: string): Promise<{
  user_id: string;
  team_id: string;
  display_name: string;
  avatar_url: string;
}> {
  const resp = await fetchWithRetry(
    'https://open.feishu.cn/open-apis/authen/v1/user_info',
    {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    }
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new AppError(40100, '飞书用户信息获取失败', `HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const body = await resp.json() as any;
  const user = body?.data;
  if (!user) {
    throw new AppError(50002, '飞书用户数据异常', '缺少 data 字段');
  }

  return {
    user_id: user.open_id || user.user_id,
    team_id: user.tenant_key || '',
    display_name: user.name || user.en_name || user.open_id || '未知用户',
    avatar_url: user.avatar_url || user.avatar_thumb || '',
  };
}

/**
 * 首次 SSO 登录自动创建用户记录（upsert）
 * 日志中不输出敏感信息（user_id 脱敏）
 */
async function upsertUser(
  user: { user_id: string; team_id: string; display_name: string; avatar_url: string }
): Promise<void> {
  try {
    const existing = await knex('users')
      .where({ user_id: user.user_id })
      .first();

    if (existing) {
      // 更新最后登录时间和姓名快照
      await knex('users')
        .where({ user_id: user.user_id })
        .update({
          display_name: user.display_name,
          avatar_url: user.avatar_url || existing.avatar_url,
          last_login_at: new Date().toISOString(),
        });
    } else {
      await knex('users').insert({
        user_id: user.user_id,
        team_id: user.team_id,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        created_at: new Date().toISOString(),
        last_login_at: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    // 用户 upsert 失败不影响主流程，仅记录日志（脱敏）
    const safeUserId = crypto.createHash('sha256')
      .update(user.user_id).digest('hex').slice(0, 12);
    console.error('[AuthRoute] upsertUser 失败（不影响登录）', {
      userId: safeUserId,
      err: (err as Error).message,
    });
  }
}

// ============================================================
// 路由工厂
// ============================================================

export function createAuthRouter(redis: Redis): Router {
  const router = Router();

  /**
   * GET /api/auth/feishu/redirect
   *
   * 302 跳转到飞书 OAuth 授权页（Login.tsx 通过 window.location.href 直接跳转）。
   * 生成随机 state 存入 Redis（TTL 10 分钟），用于 CSRF 防护。
   *
   * 查询参数：
   * - redirect?: 登录成功后的前端回调地址（可选）
   *
   * 响应：302 Location → 飞书授权 URL
   */
  router.get('/feishu/redirect', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // 检查飞书凭证
      if (!config.FEISHU_APP_ID) {
        throw new AppError(50001, '飞书应用 ID 未配置', '请联系管理员配置 FEISHU_APP_ID');
      }

      // 生成 CSRF state
      const state = generateState();

      // 构造回调地址
      const redirectUri = config.FEISHU_REDIRECT_URI;
      if (!redirectUri) {
        throw new AppError(50001, '飞书回调地址未配置', '请设置 FEISHU_REDIRECT_URI');
      }

      // 将 state 存入 Redis（TTL 10 分钟）
      const stateKey = `oauth:state:${state}`;
      try {
        // 存储 state → 空占位（callback 时只验证存在性）
        await redis.set(stateKey, '1', 'EX', config.OAUTH_STATE_TTL);
      } catch (err) {
        console.error('[AuthRoute] Redis 存储 state 失败:', err);
        // Redis 不可用时仍允许重定向（降级模式，风险接受）
      }

      // 构造飞书授权 URL
      // page_type=pc: 默认 PC 端授权页
      // redirect_uri: 须在飞书开放平台配置
      const params = new URLSearchParams({
        app_id: config.FEISHU_APP_ID,
        redirect_uri: redirectUri,
        state,
        page_type: 'pc',
      });

      const authorizeUrl = `${config.FEISHU_AUTHORIZE_URL}?${params.toString()}`;

      console.info('[AuthRoute] 302 跳转飞书授权 URL', {
        state: state.slice(0, 8) + '...',
      });

      res.redirect(302, authorizeUrl);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/auth/feishu/callback
   *
   * 接收飞书 OAuth 回调。
   * 1. 验证 state 参数（CSRF 防护）
   * 2. 用 code 换取 user_access_token
   * 3. 获取用户信息
   * 4. 自动创建/更新用户记录
   * 5. 签发 JWT，302 重定向到前端（携带 token）
   *
   * 查询参数：
   * - code: 飞书回调的授权码
   * - state: 授权请求时生成的 state
   *
   * 响应：302 重定向到前端，URL hash 携带 JWT token
   * 或 JSON（无 redirect_uri 时）：{ code: 0, data: { token, user } }
   */
  router.get('/feishu/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string };

      // ---- 1. 参数校验 ----
      if (!code) {
        throw new AppError(40001, '参数校验失败', '缺少 code 参数');
      }
      if (!state) {
        throw new AppError(40001, '参数校验失败', '缺少 state 参数');
      }

      // ---- 2. 验证 state（CSRF 防护） ----
      const stateKey = `oauth:state:${state}`;
      let stateValid = false;
      try {
        const stored = await redis.get(stateKey);
        if (stored) {
          stateValid = true;
          await redis.del(stateKey); // 一次性使用
        }
      } catch (err) {
        console.error('[AuthRoute] Redis 读取 state 失败:', err);
        // Redis 不可用时跳过 state 验证（降级，风险接受）
        stateValid = true;
      }

      if (!stateValid) {
        throw new AppError(40001, '参数校验失败', 'state 无效或已过期');
      }

      // ---- 3. 换取 user_access_token ----
      const tokenData = await exchangeCodeForToken(code);

      // ---- 4. 获取用户信息 ----
      const userInfo = await getUserInfo(tokenData.access_token);

      // 用户 ID 脱敏（仅日志用）
      const safeUserId = crypto.createHash('sha256')
        .update(userInfo.user_id).digest('hex').slice(0, 12);

      console.info('[AuthRoute] 飞书 SSO 登录成功', {
        userId: safeUserId,
        teamId: userInfo.team_id,
        displayName: userInfo.display_name,
      });

      // ---- 5. 自动创建/更新用户记录 ----
      await upsertUser(userInfo);

      // ---- 6. 签发 JWT ----
      const jwtPayload = {
        user_id: userInfo.user_id,
        team_id: userInfo.team_id,
        display_name: userInfo.display_name,
      };

      const token = jwt.sign(
        jwtPayload,
        config.JWT_SECRET,
        { expiresIn: config.JWT_EXPIRES_IN } as jwt.SignOptions
      );

      console.info('[AuthRoute] JWT 签发完成', {
        userId: safeUserId,
      });

      // ---- 7. 根据请求来源决定响应格式 ----
      // - API 调用（X-Requested-With: XMLHttpRequest / Accept: application/json）→ 返回 JSON
      // - 浏览器直接跳转（飞书回调后打开）→ 302 重定向到前端首页，URL 携带 token
      const frontendUrl = config.FRONTEND_URL || 'http://localhost:5173';

      // 设置 httpOnly cookie，浏览器自动携带
      res.cookie('feishu_token', token, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 小时（与 JWT_EXPIRES_IN 对齐）
        path: '/',
      });

      const accept = req.headers.accept || '';
      const xRequestedWith = req.headers['x-requested-with'] || '';
      const isApiCall = accept.includes('application/json') || xRequestedWith === 'XMLHttpRequest';

      if (isApiCall) {
        // ── API 调用：返回 JSON（AuthCallback.tsx 通过 axios 调用）──
        console.info('[AuthRoute] API 调用返回 JSON', { userId: safeUserId });
        res.json({
          code: 0,
          data: {
            token,
            user_id: userInfo.user_id,
            display_name: userInfo.display_name,
            avatar_url: userInfo.avatar_url,
          },
        });
      } else {
        // ── 浏览器跳转：302 重定向回前端首页，URL 中携带 token 参数 ──
        // 前端在根路由 /?token=XXX 或首页解析 ?token= 存入 localStorage
        const frontendRedirectUrl = `${frontendUrl}?token=${encodeURIComponent(token)}&user_id=${encodeURIComponent(userInfo.user_id)}&display_name=${encodeURIComponent(userInfo.display_name)}`;

        console.info('[AuthRoute] 302 跳转回前端首页', { userId: safeUserId });
        res.redirect(302, frontendRedirectUrl);
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/auth/dev/login
   *
   * 开发环境快速登录（仅 NODE_ENV !== 'production' 时可用）
   * 用于前端 dev 模式直连后端时，无需走完整 OAuth 流程
   *
   * 请求体：
   * { user_id?: string, team_id?: string, display_name?: string }
   *
   * 响应：
   * { code: 0, data: { token: "dev_<user_id>_<team_id>_<display_name>" } }
   */
  router.post('/dev/login', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (config.NODE_ENV === 'production') {
        throw new AppError(40302, '生产环境不支持开发登录', undefined);
      }

      const userId = (req.body?.user_id as string) || 'ou_dev_user_001';
      const teamId = (req.body?.team_id as string) || 'dev_team_001';
      const displayName = (req.body?.display_name as string) || '开发用户';

      // 对特殊字符做安全编码
      const safeUserId = encodeURIComponent(userId);
      const safeTeamId = encodeURIComponent(teamId);
      const safeName = encodeURIComponent(displayName);

      const devToken = `${DEV_TOKEN_PREFIX}${safeUserId}_${safeTeamId}_${safeName}`;

      console.info('[AuthRoute] dev 登录', { userId: userId.slice(0, 16) + '...' });

      res.json({
        code: 0,
        data: {
          token: devToken,
          user: {
            user_id: userId,
            team_id: teamId,
            display_name: displayName,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/auth/me
   *
   * 返回当前登录用户信息。
   * 从请求头 Authorization 或 cookie token 中解析 JWT，返回用户 id/name/avatar。
   *
   * 响应：
   * { code: 0, data: { user_id, team_id, display_name, avatar_url } }
   */
  router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 从 Authorization header 或 cookie 中提取 token
      let token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) {
        const cookies = req.headers.cookie;
        if (cookies) {
          const parsed = cookie.parse(cookies);
          token = parsed.token || parsed.session;
        }
      }

      if (!token) {
        throw new AppError(40100, '未登录或登录已过期，请重新登录', undefined);
      }

      const user = await verifyFeishuToken(token);

      // 从数据库获取 user 记录以获取 avatar_url
      let avatarUrl = '';
      try {
        const record = await knex('users')
          .select('avatar_url')
          .where({ user_id: user.user_id })
          .first();
        if (record?.avatar_url) {
          avatarUrl = record.avatar_url;
        }
      } catch {
        // 数据库查询失败不影响主流程
      }

      res.json({
        code: 0,
        data: {
          user_id: user.user_id,
          team_id: user.team_id,
          display_name: user.display_name,
          avatar_url: avatarUrl,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/auth/logout
   *
   * 清除用户登录会话。
   * 设置 Set-Cookie 使 token/session cookie 立即过期。
   *
   * 响应：
   * { code: 0, message: '已登出' }
   */
  router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 设置 cookie 过期（清除可能存在的 token/session cookie）
      const clearCookieOpts = {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
        expires: new Date(0),
      };

      res.setHeader('Set-Cookie', [
        cookie.serialize('token', '', clearCookieOpts),
        cookie.serialize('session', '', clearCookieOpts),
      ]);

      res.json({
        code: 0,
        message: '已登出',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
