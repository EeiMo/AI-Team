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
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './pages/Login';
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
          <Route path="/" element={<Navigate to="/votes" replace />} />
          <Route path="/votes" element={<RequireAuth><VoteList /></RequireAuth>} />
          <Route path="/votes/new" element={<RequireAuth><CreateVote /></RequireAuth>} />
          <Route path="/votes/:id" element={<RequireAuth><VoteDetail /></RequireAuth>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
