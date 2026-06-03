/**
 * components/VoteCard.tsx
 * 投票卡片：状态指示点、标题、标签行、进度条、创建者删除按钮（U-04）
 * 用于 VoteList 页面的列表渲染
 *
 * Props:
 * - vote: 投票数据
 * - isCreator: 是否为当前用户的投票
 * - onDelete: 删除回调（可选）
 * - isDeleted: 是否正在被删除（控制淡出动效）
 */
import { useNavigate } from 'react-router-dom';
import { memo } from 'react';
import type { Vote } from '../types';
import styles from './VoteCard.module.css';

interface VoteCardProps {
  vote: Vote;
  isCreator?: boolean;
  onDelete?: (voteId: string) => void;
  isDeleted?: boolean;
}

function VoteCard({ vote, isCreator = false, onDelete, isDeleted = false }: VoteCardProps) {
  const navigate = useNavigate();
  const isActive = vote.status === 'active';

  // 格式化截止时间
  const getRemaining = (): string => {
    if (!isActive) return '已结束';
    const now = Date.now();
    const deadline = new Date(vote.deadline).getTime();
    const diff = Math.max(0, Math.floor((deadline - now) / 1000));
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // 删除按钮点击（阻止卡片点击跳转）
  const handleDeleteClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onDelete?.(vote.id);
  };

  const typeLabel = vote.vote_type === 'single' ? '单选' : '多选';
  const modeLabel = vote.vote_mode === 'anonymous' ? '匿名' : '实名';
  const voteCount = vote.vote_count ?? 0;
  const progressPercent = vote.total_voters > 0
    ? Math.min(100, Math.round((voteCount / vote.total_voters) * 100))
    : 0;

  return (
    <div
      className={`${styles.card} ${isDeleted ? styles.deleted : ''} ${isActive ? styles.cardActive : styles.cardClosed}`}
      onClick={() => !isDeleted && navigate(`/votes/${vote.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !isDeleted) navigate(`/votes/${vote.id}`);
      }}
      aria-disabled={isDeleted}
    >
      <div className={styles.header}>
        <span className={`${styles.dot} ${isActive ? styles.dotActive : styles.dotClosed}`} />
        <h3 className={styles.title}>{vote.title}</h3>
      </div>
      <div className={styles.tags}>
        <span className={styles.tag}>{typeLabel}</span>
        <span className={styles.tag}>{modeLabel}</span>
        <span className={`${styles.tag} ${isActive ? styles.tagTime : ''}`}>
          {isActive ? `剩余 ${getRemaining()}` : '已结束'}
        </span>
      </div>
      <div className={styles.footer}>
        <div className={styles.progressRow}>
          <span className={styles.progressText}>
            已投 {voteCount}/{vote.total_voters} 人
          </span>
          <div className={styles.progressBar}>
            <div
              className={`${styles.progressFill} ${isActive ? styles.progressFillActive : styles.progressFillClosed}`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
        {/* 仅创建者可见的删除按钮 */}
        {isCreator && onDelete && (
          <button
            className={styles.deleteBtn}
            onClick={handleDeleteClick}
            aria-label="删除投票"
            title="删除投票"
          >
            🗑️
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(VoteCard);
