/**
 * pages/Login.tsx
 * 飞书 SSO 登录 + dev 降级模式
 *
 * - VITE_AUTH_MODE=sso：显示飞书登录按钮为主流程，dev 手动登录折叠为备选
 * - VITE_AUTH_MODE=dev：显示手动输入登录表单
 */
import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './Login.module.css';

/** 飞书品牌色 */
const FEISHU_BLUE = '#3370ff';

export default function Login() {
  const authMode = import.meta.env.VITE_AUTH_MODE || 'sso';
  const apiBase = import.meta.env.VITE_API_BASE || '';

  // ---- dev 手动登录 state ----
  const [userId, setUserId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [showDevLogin, setShowDevLogin] = useState(authMode === 'dev');
  const [ssoError, setSsoError] = useState('');
  const navigate = useNavigate();

  // ---- 飞书 SSO 登录 ----
  const handleFeishuLogin = () => {
    setSsoError('');
    // 直接跳转到后端飞书授权重定向端点
    // 后端 /api/auth/feishu/redirect 会 302 到飞书授权页
    window.location.href = '/api/auth/feishu/redirect';
  };

  // ---- dev 手动登录 ----
  const handleDevSubmit = (e: FormEvent) => {
    e.preventDefault();
    const id = userId.trim();
    const name = displayName.trim();

    if (!id) {
      setError('请输入用户 ID');
      return;
    }
    if (!name) {
      setError('请输入昵称');
      return;
    }
    if (id.length > 64) {
      setError('用户 ID 不超过 64 个字符');
      return;
    }

    // 生成 dev token: dev_userId_teamId_displayName
    const token = `dev_${id}_default_${name}`;
    localStorage.setItem('feishu_token', token);
    localStorage.setItem('feishu_user_id', id);
    localStorage.setItem('feishu_display_name', name);
    navigate('/votes', { replace: true });
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        {/* ---- 头部 ---- */}
        <div className={styles.header}>
          <div className={styles.logoWrapper}>
            {/* 彩色圆点 logo */}
            <svg className={styles.logo} viewBox="0 0 48 48" width="48" height="48" fill="none">
              <circle cx="24" cy="24" r="22" fill={FEISHU_BLUE} opacity="0.1" />
              <circle cx="24" cy="14" r="6" fill={FEISHU_BLUE} />
              <circle cx="14" cy="30" r="6" fill="#00b578" />
              <circle cx="34" cy="30" r="6" fill="#ff8800" />
            </svg>
          </div>
          <h1 className={styles.title}>团队即时投票</h1>
          <p className={styles.subtitle}>
            {authMode === 'dev' ? '输入身份信息开始使用' : '使用飞书账号一键登录'}
          </p>
        </div>

        {/* ---- SSO 登录区域 ---- */}
        {authMode === 'sso' && (
          <div className={styles.ssoSection}>
            <button
              className={styles.feishuButton}
              onClick={handleFeishuLogin}
              type="button"
            >
              <svg className={styles.feishuIcon} viewBox="0 0 24 24" width="20" height="20" fill="none">
                <rect width="24" height="24" rx="5" fill="#fff" />
                <path d="M18.5 5h-13C4.12 5 3 6.12 3 7.5v9C3 17.88 4.12 19 5.5 19h13c1.38 0 2.5-1.12 2.5-2.5v-9C21 6.12 19.88 5 18.5 5z" fill={FEISHU_BLUE} />
                <path d="M7 9.5L12 14l5-4.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              飞书登录
            </button>

            {ssoError && <p className={styles.error}>{ssoError}</p>}

            {/* dev 降级入口 */}
            <button
              className={styles.devToggle}
              onClick={() => setShowDevLogin(!showDevLogin)}
              type="button"
            >
              {showDevLogin ? '收起' : '开发人员入口'}
            </button>
          </div>
        )}

        {/* ---- Dev 手动登录区域 ---- */}
        {showDevLogin && (
          <form onSubmit={handleDevSubmit} className={styles.form}>
            <div className={styles.divider}>
              <span className={styles.dividerText}>手动登录</span>
            </div>

            <label className={styles.label}>
              用户 ID
              <input
                className={styles.input}
                type="text"
                value={userId}
                onChange={(e) => { setUserId(e.target.value); setError(''); }}
                placeholder="例如：zhangsan"
                autoFocus
                maxLength={64}
              />
            </label>

            <label className={styles.label}>
              昵称
              <input
                className={styles.input}
                type="text"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setError(''); }}
                placeholder="例如：张三"
                maxLength={32}
              />
            </label>

            {error && <p className={styles.error}>{error}</p>}

            <button className={styles.devButton} type="submit">
              进入投票
            </button>
          </form>
        )}

        {/* ---- 底部 ---- */}
        {!showDevLogin && authMode === 'dev' && (
          <p className={styles.footer}>连接飞书 SSO 后将自动登录，无需手动输入</p>
        )}
      </div>
    </div>
  );
}
