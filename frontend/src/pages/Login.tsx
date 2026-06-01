/**
 * pages/Login.tsx
 * 简易登录页：MVP 无飞书 SSO 时，用户输入 ID 和昵称即可使用
 * 生产环境连接飞书 SSO 后此页面可替换为飞书 OAuth 跳转
 */
import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './Login.module.css';

export default function Login() {
  const [userId, setUserId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleSubmit = (e: FormEvent) => {
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
    // 对应后端 auth.ts 降级模式的解析逻辑
    const token = `dev_${id}_default_${name}`;
    localStorage.setItem('feishu_token', token);
    navigate('/votes', { replace: true });
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>团队即时投票</h1>
        <p className={styles.subtitle}>输入你的身份信息开始使用</p>

        <form onSubmit={handleSubmit} className={styles.form}>
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

          <button className={styles.button} type="submit">
            进入投票
          </button>
        </form>

        <p className={styles.footer}>
          连接飞书 SSO 后将自动登录，无需手动输入
        </p>
      </div>
    </div>
  );
}
