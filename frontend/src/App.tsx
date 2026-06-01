/**
 * App.tsx
 * 路由根组件：React Router v6 路由表
 *
 * 路由：
 * - /votes     → VoteList（投票列表页，默认 active tab）
 * - /votes/new → CreateVote（创建投票页）
 * - /votes/:id → VoteDetail（投票详情页，状态驱动 active/closed）
 * - /          → 重定向到 /votes
 * - *          → 404
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import VoteList from './pages/VoteList';
import CreateVote from './pages/CreateVote';
import VoteDetail from './pages/VoteDetail';
import styles from './App.module.css';

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
          <Route path="/" element={<Navigate to="/votes" replace />} />
          <Route path="/votes" element={<VoteList />} />
          <Route path="/votes/new" element={<CreateVote />} />
          <Route path="/votes/:id" element={<VoteDetail />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
