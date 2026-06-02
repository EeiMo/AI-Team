/**
 * App.tsx
 * 路由根组件：React Router v6 路由表
 *
 * 路由：
 * - /login    → Login（飞书未就绪时的简易登录页）
 * - /votes     → VoteList（投票列表页，默认 active tab）
 * - /votes/new → CreateVote（创建投票页）
 * - /votes/:id → VoteDetail（投票详情页，状态驱动 active/closed）
 * - /          → 重定向到 /votes
 * - *          → 404
 */
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import VoteList from './pages/VoteList';
import CreateVote from './pages/CreateVote';
import VoteDetail from './pages/VoteDetail';
import styles from './App.module.css';

/** 未登录则重定向到 /login */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const token = localStorage.getItem('feishu_token');
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}


function NotFound() {
  return (
    <div className={styles.notFound}>
      <h2>404</h2>
      <p>页面不存在</p>
      <a href="/votes">返回投票列表</a>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className={styles.app}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/" element={<TokenRedirector />} />
          <Route path="/votes" element={<RequireAuth><VoteList /></RequireAuth>} />
          <Route path="/votes/new" element={<RequireAuth><CreateVote /></RequireAuth>} />
          <Route path="/votes/:id" element={<RequireAuth><VoteDetail /></RequireAuth>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

/**
 * TokenRedirector：根路由 / 的组件
 * 1. 解析 URL 中的 token/user_id/display_name 参数并存入 localStorage
 * 2. 重定向到 /votes
 */
function TokenRedirector() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  useEffect(() => {
    const token = searchParams.get('token');
    const error = searchParams.get('error');
    const userId = searchParams.get('user_id');
    const displayName = searchParams.get('display_name');

    if (token) {
      localStorage.setItem('feishu_token', token);
      if (userId) localStorage.setItem('feishu_user_id', userId);
      if (displayName) localStorage.setItem('feishu_display_name', displayName);
      // 清除 query 参数后重定向
      setSearchParams({}, { replace: true });
    }

    if (error) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const token = localStorage.getItem('feishu_token');
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <Navigate to="/votes" replace />;
}
