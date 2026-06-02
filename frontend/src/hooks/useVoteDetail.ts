/**
 * hooks/useVoteDetail.ts
 * 投票详情数据 Hook：初始加载、WS 增量更新、乐观更新与回滚
 *
 * 乐观更新流程：
 * 1. 用户提交投票 → 本地 options[].count + 1（仅选中项）
 * 2. 若服务端返回成功（code=0）→ 保持乐观数据，WS 广播补充
 * 3. 若服务端返回失败 → 回滚（全量重新拉取最新状态）
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import api, { ApiError } from '../services/api';
import { useSocket } from './useSocket';
import type { ApiResponse, VoteDetailData, Vote, Option, WsVoteUpdate, WsVoteClosed, WsReminder, CloseVoteResponse } from '../types';

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
  optimisticCounts: Record<string, number>; // option_id → ±偏移量
  reminderToast: boolean;
  dismissReminder: () => void;
  submitVote: (optionIds: string[]) => Promise<SubmitVoteResult>;
  closeVote: () => Promise<boolean>;
  deleteVote: () => Promise<boolean>;
  refetch: () => Promise<void>;
  closingVote: boolean;
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
      setVote(data.vote);
      setOptions(data.vote.options ?? []);
      setHasVoted(data.has_voted);
      setMySelectedOptions(data.my_selected_options);
      hasVotedRef.current = data.has_voted;
      optionsRef.current = data.vote.options ?? [];
      // 重置乐观偏移
      setOptimisticCounts({});
    } catch (err: unknown) {
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
    // 增量更新指定 option 的 count
    setOptions((prev) =>
      prev.map((opt) =>
        opt.id === payload.option_id
          ? { ...opt, count: payload.new_count }
          : opt
      )
    );
    // 服务端推送的 new_count 已是权威值，清除对应 option 的乐观偏移
    setOptimisticCounts((prev) => {
      if (!(payload.option_id in prev)) return prev;
      const next = { ...prev };
      delete next[payload.option_id];
      return next;
    });
  }, []);

  const handleClosed = useCallback((_payload: WsVoteClosed) => {
    // 全量重新拉取，确保与后端一致
    fetchDetail();
  }, [fetchDetail]);

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
    onReminder: handleReminder,
    onReconnect: fetchDetail,
  });

  // ---- 提交投票（含乐观更新） ----
  const submitVote = useCallback(async (optionIds: string[]): Promise<SubmitVoteResult> => {
    // 乐观更新：本地计数 +1
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
      // 成功 → 乐观数据保持，标记已投票
      setHasVoted(true);
      setMySelectedOptions(optionIds);
      hasVotedRef.current = true;
      return { ok: true };
    } catch (err: unknown) {
      // 失败 → 回滚：重置乐观偏移 + 全量重新拉取
      setOptimisticCounts({});
      await fetchDetail();

      // 分类错误原因
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
      // 直接用服务端响应更新本地状态，避免重复 fetch（WS handleClosed 会广播给其他用户）
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

  // ---- 删除投票 ----
  const deleteVote = useCallback(async (): Promise<boolean> => {
    try {
      await api.delete(`/votes/${voteId}`);
      return true;
    } catch {
      return false;
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
    deleteVote,
    refetch: fetchDetail,
    closingVote,
  };
}
