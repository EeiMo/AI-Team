/**
 * pages/AuthCallback.tsx
 * 飞书 OAuth 回调页：解析 code/state → 调用后端 /api/auth/feishu/callback → 存储 token
 * 成功跳转 /votes，失败显示错误
 */
import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { feishuCallback } from '../services/api';
import styles from './Login.module.css';

export default function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code || !state) {
      setError('授权参数缺失，请重新登录');
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const data = await feishuCallback(code, state);
        if (cancelled) return;

        localStorage.setItem('feishu_token', data.token);
        localStorage.setItem('feishu_user_id', data.user_id);
        localStorage.setItem('feishu_display_name', data.display_name);
        if (data.avatar_url) {
          localStorage.setItem('feishu_avatar_url', data.avatar_url);
        }

        navigate('/votes', { replace: true });
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message ?? '飞书登录失败，请重试');
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [searchParams, navigate]);

  if (loading && !error) {
    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <div className={styles.loadingSpinner} />
          <p className={styles.loadingText}>飞书登录中…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>登录失败</h1>
        <p className={styles.error}>{error}</p>
        <button className={styles.button} onClick={() => navigate('/login', { replace: true })}>
          返回登录
        </button>
      </div>
    </div>
  );
}
