/**
 * hooks/useVoteDetail.ts
 * 投票详情数据 Hook：初始加载、WS 增量更新、乐观更新与回滚、删除状态
 *
 * v3 新增:
 * - deleted 状态：监听 vote:{id}:deleted 事件
 * - 删除时自动将 vote.deleted = true，驱动已删除占位页
 *
 * 乐观更新流程：
 * 1. 用户提交投票 → 本地 options[].count + 1（仅选中项）
 * 2. 若服务端返回成功（code=0）→ 保持乐观数据，WS 广播补充
 * 3. 若服务端返回失败 → 回滚（全量重新拉取最新状态）
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import api, { ApiError } from '../services/api';
import { useSocket } from './useSocket';
import type { ApiResponse, VoteDetailData, Vote, Option, WsVoteUpdate, WsVoteClosed, WsVoteDeleted, WsReminder, CloseVoteResponse } from '../types';

export interface SubmitVoteResult {
  ok: boolean;
  reason?: 'duplicate' | 'closed' | 'rate_limited' | 'network' | 'unknown';
}

interface UseVoteDetailReturn {
  vote: Vote | null;
  options: Option[];
  hasVoted: boolean;
  mySelectedOptions: string[];
  loading: boolean;
  error: string | null;
  optimisticCounts: Record<string, number>;
  reminderToast: boolean;
  dismissReminder: () => void;
  submitVote: (optionIds: string[]) => Promise<SubmitVoteResult>;
  closeVote: () => Promise<boolean>;
  refetch: () => Promise<void>;
  closingVote: boolean;
  /** 投票是否已被创建者删除 */
  deleted: boolean;
}

export function useVoteDetail(voteId: string): UseVoteDetailReturn {
  const [vote, setVote] = useState<Vote | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [hasVoted, setHasVoted] = useState(false);
  const [mySelectedOptions, setMySelectedOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [optimisticCounts, setOptimisticCounts] = useState<Record<string, number>>({});
  const [closingVote, setClosingVote] = useState(false);
  const [reminderToast, setReminderToast] = useState(false);
  const [deleted, setDeleted] = useState(false);

  // 用 ref 追踪当前是否已投票，避免闭包旧值
  const hasVotedRef = useRef(false);
  const optionsRef = useRef<Option[]>([]);

  // ---- 拉取详情 ----
  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ApiResponse<VoteDetailData>>(`/votes/${voteId}`);
      const data = res.data.data!;
      // 检查是否已被删除
      if (data.vote.deleted) {
        setDeleted(true);
      }
      setVote(data.vote);
      setOptions(data.vote.options ?? []);
      setHasVoted(data.has_voted);
      setMySelectedOptions(data.my_selected_options);
      hasVotedRef.current = data.has_voted;
      optionsRef.current = data.vote.options ?? [];
      // 重置乐观偏移
      setOptimisticCounts({});
    } catch (err: unknown) {
      // 404 也可能表示投票已被删除（后端返回 code ≠ 0）
      if (err instanceof ApiError && (err.code === 40401 || err.message.includes('不存在'))) {
        setDeleted(true);
        setError(null);
        // 设置一个虚拟 vote 用于显示已删除占位页
        setVote({
          id: voteId,
          title: '—',
          creator_id: '',
          creator_name: '',
          team_id: '',
          vote_type: 'single',
          vote_mode: 'anonymous',
          status: 'closed',
          deadline: '',
          total_voters: 0,
          created_at: '',
          closed_at: null,
          closed_by: null,
          deleted: true,
        });
        setLoading(false);
        return;
      }
      const msg = err instanceof Error ? err.message : '加载失败';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [voteId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // ---- WS 事件处理 ----
  const handleUpdate = useCallback((payload: WsVoteUpdate) => {
    setOptions((prev) =>
      prev.map((opt) =>
        opt.id === payload.option_id
          ? { ...opt, count: payload.new_count }
          : opt
      )
    );
    setOptimisticCounts((prev) => {
      if (!(payload.option_id in prev)) return prev;
      const next = { ...prev };
      delete next[payload.option_id];
      return next;
    });
  }, []);

  const handleClosed = useCallback((_payload: WsVoteClosed) => {
    fetchDetail();
  }, [fetchDetail]);

  const handleDeleted = useCallback((_payload: WsVoteDeleted) => {
    // 投票被删除 → 标记 deleted 状态，驱动已删除占位页
    setDeleted(true);
    setVote((prev) =>
      prev ? { ...prev, deleted: true } : null
    );
    setLoading(false);
  }, []);

  const handleReminder = useCallback((_payload: WsReminder) => {
    setReminderToast(true);
  }, []);

  const dismissReminder = useCallback(() => {
    setReminderToast(false);
  }, []);

  // 连接 WS
  useSocket({
    voteId,
    onUpdate: handleUpdate,
    onClosed: handleClosed,
    onDeleted: handleDeleted,
    onReminder: handleReminder,
    onReconnect: fetchDetail,
  });

  // ---- 提交投票（含乐观更新） ----
  const submitVote = useCallback(async (optionIds: string[]): Promise<SubmitVoteResult> => {
    const delta: Record<string, number> = {};
    optionIds.forEach((oid) => {
      delta[oid] = 1;
    });
    setOptimisticCounts((prev) => {
      const next = { ...prev };
      Object.entries(delta).forEach(([k, v]) => {
        next[k] = (next[k] ?? 0) + v;
      });
      return next;
    });

    try {
      await api.post<ApiResponse>(`/votes/${voteId}/vote`, {
        option_ids: optionIds,
      });
      setHasVoted(true);
      setMySelectedOptions(optionIds);
      hasVotedRef.current = true;
      return { ok: true };
    } catch (err: unknown) {
      setOptimisticCounts({});
      await fetchDetail();

      if (err instanceof ApiError) {
        if (err.code === 40901) return { ok: false, reason: 'duplicate' };
        if (err.code === 40301) return { ok: false, reason: 'closed' };
        if (err.code === 42900) return { ok: false, reason: 'rate_limited' };
        return { ok: false, reason: 'unknown' };
      }
      return { ok: false, reason: 'network' };
    }
  }, [voteId, fetchDetail]);

  // ---- 结束投票 ----
  const closeVote = useCallback(async (): Promise<boolean> => {
    setClosingVote(true);
    try {
      const res = await api.post<ApiResponse<CloseVoteResponse>>(`/votes/${voteId}/close`);
      const data = res.data.data!;
      setVote((prev) =>
        prev
          ? { ...prev, status: 'closed', closed_by: data.closed_by, closed_at: data.closed_at }
          : null
      );
      return true;
    } catch {
      return false;
    } finally {
      setClosingVote(false);
    }
  }, [voteId]);

  return {
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
    refetch: fetchDetail,
    closingVote,
    deleted,
  };
}
