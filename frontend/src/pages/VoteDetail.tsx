/**
 * pages/VoteDetail.tsx
 * 投票详情页：根据 status 和 deleted 渲染 active/closed/deleted 视图（v3）
 *
 * 新增：
 * - 已删除占位页（F-303）
 * - 创建者删除按钮（F-301/309）
 * - WS 监听 vote:{id}:deleted
 * - 实时结果卡片化（U-03）
 * - 顶部信息栏卡片化（U-07）
 */
import { useParams, useNavigate } from 'react-router-dom';
import { useVoteDetail } from '../hooks/useVoteDetail';
import { useNetworkStore } from '../store';
import OptionList from '../components/OptionList';
import ResultChart from '../components/ResultChart';
import CountdownTimer from '../components/CountdownTimer';
import NetworkBanner from '../components/NetworkBanner';
import DeleteConfirm from '../components/DeleteConfirm';
import { deleteVote, ApiError } from '../services/api';
import { useState, useCallback, useMemo, useEffect } from 'react';
import styles from './VoteDetail.module.css';

export default function VoteDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    vote,
    options,
    hasVoted,
    mySelectedOptions,
    loading,
    error,
    optimisticCounts,
    reminderToast,
    dismissReminder,
    submitVote,
    closeVote,
    closingVote,
    deleted,
  } = useVoteDetail(id!);

  // 用于 OptionList 的选中状态
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submittingVote, setSubmittingVote] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  // 删除状态
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingVote, setDeletingVote] = useState(false);
  const [deletedToast, setDeletedToast] = useState<string | null>(null);

  // 判断当前用户是否为发起者
  const isCreator = useMemo(() => {
    const currentUserId = localStorage.getItem('feishu_user_id') ?? '';
    return vote?.creator_id === currentUserId;
  }, [vote]);

  const isActive = vote?.status === 'active';

  // 匿名模式 + 进行中 + 未投票 → 显示隐私声明
  const showPrivacyBanner = isActive && !hasVoted && vote?.vote_mode === 'anonymous';

  // 切换选项
  const handleToggle = useCallback((optionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(optionId)) {
        next.delete(optionId);
      } else {
        next.add(optionId);
      }
      return next;
    });
  }, []);

  // 提交投票
  const handleSubmitVote = async () => {
    if (selected.size === 0) return;
    setSubmittingVote(true);
    setSubmitError(null);
    const optionIds = Array.from(selected);
    const result = await submitVote(optionIds);
    if (!result.ok) {
      switch (result.reason) {
        case 'duplicate':
          setSubmitError('您已投过票，不可重复提交');
          break;
        case 'closed':
          setSubmitError('投票已结束');
          setTimeout(() => window.location.reload(), 1500);
          break;
        case 'rate_limited':
          setSubmitError('操作过于频繁，请稍后再试');
          break;
        case 'network':
          setSubmitError('网络异常，请稍后重试');
          break;
        default:
          setSubmitError('投票失败，请稍后重试');
      }
    }
    setSubmittingVote(false);
  };

  // 结束投票
  const handleCloseVote = async () => {
    setShowCloseConfirm(false);
    const ok = await closeVote();
    if (!ok) {
      alert('操作失败，请稍后重试');
    }
  };

  // 删除投票
  const handleDeleteVote = async () => {
    if (!vote) return;
    setDeletingVote(true);
    try {
      await deleteVote(vote.id);
      setShowDeleteConfirm(false);
      setDeletedToast('投票已删除');
      // 页面切换到已删除占位页 → 通过 vote.deleted 状态驱动
      // reload 让后端返回 deleted:true
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : '删除失败，请稍后重试';
      alert(msg);
    } finally {
      setDeletingVote(false);
    }
  };

  // 删除成功 Toast auto-dismiss
  useEffect(() => {
    if (deletedToast) {
      const timer = setTimeout(() => setDeletedToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [deletedToast]);

  // 倒计时归零回调
  const handleExpire = useCallback(() => {
    if (vote?.status === 'active') {
      window.location.reload();
    }
  }, [vote]);

  // ---- 加载态 ----
  if (loading) {
    return (
      <div className={styles.page}>
        <NetworkBanner />
        <div className={styles.skeletonPage}>
          <div className={styles.skeletonHeader}>
            <div className={styles.skeletonTitle} />
            <div className={styles.skeletonLine} />
            <div className={styles.skeletonLineShort} />
          </div>
          <div className={styles.skeletonCard}>
            <div className={styles.skeletonOption} />
            <div className={styles.skeletonOption} />
            <div className={styles.skeletonOption} />
          </div>
        </div>
      </div>
    );
  }

  // ---- 错误态 ----
  if (error || !vote) {
    return (
      <div className={styles.page}>
        <NetworkBanner />
        <div className={styles.error}>
          <div className={styles.errorIcon}>😵</div>
          <p>{error || '投票不存在'}</p>
          <button className={styles.backBtn} onClick={() => navigate('/votes')}>
            返回列表
          </button>
        </div>
      </div>
    );
  }

  // ---- 已删除占位页 (F-303) ----
  if (deleted) {
    return (
      <div className={styles.page}>
        <div className={styles.deletedPlaceholder}>
          <div className={styles.deletedIcon}>🗑️</div>
          <h2 className={styles.deletedTitle}>该投票已被创建者删除</h2>
          <p className={styles.deletedHint}>
            「{vote.title}」已被发起者移除，所有用户无法再查看和投票。
          </p>
          <button
            className={styles.backToListBtn}
            onClick={() => navigate('/votes')}
          >
            返回列表
          </button>
        </div>
      </div>
    );
  }

  // ---- 正常渲染 ----
  const typeLabel = vote.vote_type === 'single' ? '单选' : '多选';
  const modeLabel = vote.vote_mode === 'anonymous' ? '匿名' : '实名';

  return (
    <div className={styles.page}>
      <NetworkBanner />

      {/* WS 截止提醒 Toast */}
      {reminderToast && (
        <div className={styles.reminderToast} onClick={dismissReminder}>
          ⏰ 投票即将在 1 分钟后结束！点击关闭
        </div>
      )}

      {/* 顶部信息栏 — 卡片化 (U-07) */}
      <header className={styles.headerCard}>
        <button className={styles.backBtnCompact} onClick={() => navigate('/votes')}>
          ← 返回
        </button>
        <h1 className={styles.heading}>{vote.title}</h1>
        <div className={styles.meta}>
          <span className={styles.tag}>{typeLabel}</span>
          <span className={styles.tag}>{modeLabel}</span>
          {isActive ? (
            <CountdownTimer deadline={vote.deadline} onExpire={handleExpire} />
          ) : (
            <span className={styles.closedTag}>已结束</span>
          )}
        </div>
        <div className={styles.progressRow}>
          <div className={styles.progressBarCompact}>
            <div
              className={`${styles.progressFillCompact} ${isActive ? styles.progressFillActive : styles.progressFillClosed}`}
              style={{
                width: `${vote.total_voters > 0 ? Math.min(100, Math.round(((options.reduce((s, o) => s + (o.count ?? 0), 0) + Object.values(optimisticCounts).reduce((s, v) => s + v, 0)) / vote.total_voters) * 100)) : 0}%`,
              }}
            />
          </div>
          <span className={styles.progressText}>
            已投 {options.reduce((s, o) => s + (o.count ?? 0), 0) + Object.values(optimisticCounts).reduce((s, v) => s + v, 0)}/{vote.total_voters} 人
          </span>
        </div>
      </header>

      {/* 隐私声明 */}
      {showPrivacyBanner && (
        <div className={styles.privacyBanner}>
          📌 本次为匿名投票，你的选择不会对其他参与者显示，但系统会记录你的身份以进行防重复投票
        </div>
      )}

      {/* 选项区 — 进行中 + 未投票 */}
      {isActive && !hasVoted && (
        <section className={styles.voteSection}>
          <OptionList
            options={options}
            voteType={vote.vote_type}
            selected={selected}
            onToggle={handleToggle}
            disabled={false}
          />
          <button
            className={`${styles.submitVoteBtn} ${selected.size === 0 || submittingVote ? styles.submitVoteDisabled : ''}`}
            disabled={selected.size === 0 || submittingVote}
            onClick={handleSubmitVote}
          >
            {submittingVote ? '提交中...' : '提交投票'}
          </button>
          {submitError && <p className={styles.submitError}>{submitError}</p>}
        </section>
      )}

      {/* 选项区 — 已投票锁定只读 */}
      {isActive && hasVoted && (
        <section className={styles.voteSection}>
          <OptionList
            options={options}
            voteType={vote.vote_type}
            selected={new Set(mySelectedOptions)}
            onToggle={() => {}}
            disabled={true}
          />
          <div className={styles.votedHint}>
            ✅ 已投票 · 投票已提交，不可更改
          </div>
        </section>
      )}

      {/* 已结束 — 仅展示结果 */}
      {!isActive && (
        <section className={styles.voteSection}>
          <OptionList
            options={options}
            voteType={vote.vote_type}
            selected={new Set(mySelectedOptions)}
            onToggle={() => {}}
            disabled={true}
          />
        </section>
      )}

      {/* 实时/最终结果图表 (U-03) */}
      <ResultChart
        options={options}
        voteMode={vote.vote_mode}
        status={vote.status}
        optimisticCounts={optimisticCounts}
      />

      {/* 发起者专属操作区 (U-09) */}
      {isCreator && (
        <section className={styles.creatorActions}>
          {isActive && (
            <button
              className={styles.closeBtn}
              onClick={() => setShowCloseConfirm(true)}
              disabled={closingVote}
            >
              {closingVote ? '处理中...' : '结束投票'}
            </button>
          )}
          <button
            className={styles.deleteBtn}
            onClick={() => setShowDeleteConfirm(true)}
          >
            🗑️ 删除投票
          </button>
        </section>
      )}

      {/* 已结束页脚 */}
      {!isActive && (
        <p className={styles.closedFooter}>
          投票已结束 · 由 {vote.creator_name} 发起
        </p>
      )}

      {/* 结束确认弹窗 */}
      {showCloseConfirm && (
        <div className={styles.overlay} onClick={() => setShowCloseConfirm(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.dialogText}>
              确定结束投票吗？结束后所有人不可再投票。
            </p>
            <div className={styles.dialogActions}>
              <button className={styles.dialogCancel} onClick={() => setShowCloseConfirm(false)}>
                取消
              </button>
              <button className={styles.dialogConfirm} onClick={handleCloseVote}>
                确认结束
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <DeleteConfirm
          title={vote.title}
          onConfirm={handleDeleteVote}
          onCancel={() => setShowDeleteConfirm(false)}
          loading={deletingVote}
        />
      )}

      {/* 删除成功 Toast */}
      {deletedToast && (
        <div className={styles.deleteToast}>
          ✅ {deletedToast}
        </div>
      )}
    </div>
  );
}
