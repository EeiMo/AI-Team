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
import { useNavigate } from 'react-router-dom';
import { useFilterStore } from '../store';
import { useVotes } from '../hooks/useVotes';
import VoteCard from '../components/VoteCard';
import styles from './VoteList.module.css';
import type { ListStatus } from '../types';

export default function VoteList() {
  const navigate = useNavigate();
  const { status, setStatus } = useFilterStore();
  const { votes, total, loading, error, hasMore, loadMore } = useVotes(status as ListStatus);

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
        {votes.map((vote) => (
          <VoteCard key={vote.id} vote={vote} />
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
    </div>
  );
}
