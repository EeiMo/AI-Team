/**
 * pages/VoteList.tsx
 * 投票列表页：Tab active/closed、骨架屏、空状态、分页加载
 *
 * 对应 PRD §5.1：
 * - 顶部「团队投票」标题 + 「发起投票」按钮
 * - 「进行中」|「已结束」Tab 切换
 * - 卡片列表 + 上拉加载更多
 * - 空状态插画
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFilterStore } from '../store';
import { useVotes } from '../hooks/useVotes';
import VoteCard from '../components/VoteCard';
import DeleteConfirm from '../components/DeleteConfirm';
import { deleteVote, ApiError } from '../services/api';
import styles from './VoteList.module.css';
import type { ListStatus, WsVoteDeleted } from '../types';

export default function VoteList() {
  const navigate = useNavigate();
  const { status, setStatus } = useFilterStore();
  const { votes, total, loading, error, hasMore, loadMore, refresh } = useVotes(status as ListStatus);

  // 当前用户 ID
  const currentUserId = localStorage.getItem('feishu_user_id') ?? '';

  // 删除状态
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [deletedToast, setDeletedToast] = useState<string | null>(null);

  // WS 监听 deleted 事件（使用 Ref 避免刷新时重复注册）
  const wsRef = useRef<WebSocket | null>(null);

  // ---- 删除处理 ----
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteVote(deleteTarget.id);
      // 立即标记已删除（带淡出动画）
      setDeletedIds((prev) => new Set(prev).add(deleteTarget.id));
      setDeletedToast(`${deleteTarget.title} 已删除`);
      setDeleteTarget(null);
      // 延迟后完全移除
      setTimeout(() => {
        refresh();
      }, 600);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : '删除失败，请稍后重试';
      alert(msg);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, refresh]);

  const openDeleteConfirm = useCallback((voteId: string) => {
    const vote = votes.find((v) => v.id === voteId);
    if (vote) {
      setDeleteTarget({ id: voteId, title: vote.title });
    }
  }, [votes]);

  const dismissToast = useCallback(() => {
    setDeletedToast(null);
  }, []);

  // 延迟清除 toast
  useEffect(() => {
    if (deletedToast) {
      const timer = setTimeout(() => setDeletedToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [deletedToast]);

  // 清理已移除的 deletedIds（重新拉取后重置）
  useEffect(() => {
    if (!loading && deletedIds.size > 0) {
      setDeletedIds(new Set());
    }
  }, [votes]);

  const tabs: { key: ListStatus; label: string }[] = [
    { key: 'active', label: '进行中' },
    { key: 'closed', label: '已结束' },
  ];

  return (
    <div className={styles.page}>
      {/* 顶部栏 */}
      <header className={styles.header}>
        <h1 className={styles.heading}>团队投票</h1>
        <button className={styles.createBtn} onClick={() => navigate('/votes/new')}>
          + 发起投票
        </button>
      </header>

      {/* Tab 切换 */}
      <nav className={styles.tabs}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.tab} ${status === tab.key ? styles.tabActive : ''}`}
            onClick={() => setStatus(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* 列表区 */}
      <main className={styles.list}>
        {/* 加载骨架屏 */}
        {loading && votes.length === 0 && (
          <div className={styles.skeletonList}>
            {[1, 2, 3].map((i) => (
              <div key={i} className={styles.skeletonCard}>
                <div className={styles.skeletonLine1} />
                <div className={styles.skeletonLine2} />
                <div className={styles.skeletonLine3} />
              </div>
            ))}
          </div>
        )}

        {/* 空状态 */}
        {!loading && votes.length === 0 && !error && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>📋</div>
            <p className={styles.emptyText}>
              {status === 'active' ? '暂无进行中的投票' : '暂无已结束的投票'}
            </p>
            {status === 'active' && (
              <button className={styles.emptyCta} onClick={() => navigate('/votes/new')}>
                创建第一个投票
              </button>
            )}
          </div>
        )}

        {/* 错误 */}
        {error && (
          <div className={styles.error}>
            <p>{error}</p>
          </div>
        )}

        {/* 卡片列表 */}
        {votes.filter((v) => !deletedIds.has(v.id)).map((vote) => (
          <VoteCard
            key={vote.id}
            vote={vote}
            isCreator={vote.creator_id === currentUserId}
            onDelete={openDeleteConfirm}
            isDeleted={deletedIds.has(vote.id)}
          />
        ))}

        {/* 加载更多 */}
        {hasMore && !loading && (
          <button className={styles.loadMore} onClick={loadMore}>
            加载更多
          </button>
        )}
        {loading && votes.length > 0 && (
          <p className={styles.loadingMore}>加载中...</p>
        )}

        {/* 已全部加载 */}
        {!hasMore && votes.length > 0 && (
          <p className={styles.allLoaded}>
            共 {total} 个投票
          </p>
        )}
      </main>

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <DeleteConfirm
          title={deleteTarget.title}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          loading={deleting}
        />
      )}

      {/* 删除成功 Toast */}
      {deletedToast && (
        <div className={styles.toast} onClick={dismissToast}>
          <span className={styles.toastIcon}>✅</span>
          <span>{deletedToast}</span>
        </div>
      )}
    </div>
  );
}
