/**
 * hooks/useVotes.ts
 * 投票列表数据 Hook：分页加载、状态筛选、骨架屏控制
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import type { ApiResponse, VoteListData, Vote, ListStatus } from '../types';

interface UseVotesReturn {
  votes: Vote[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

const PAGE_SIZE = 20;

export function useVotes(status: ListStatus): UseVotesReturn {
  const [votes, setVotes] = useState<Vote[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVotes = useCallback(async (pageNum: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ApiResponse<VoteListData>>('/votes', {
        params: { status, page: pageNum, size: PAGE_SIZE },
      });
      const data = res.data.data!;
      setVotes((prev) => (append ? [...prev, ...data.items] : data.items));
      setTotal(data.total);
      setPage(pageNum);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [status]);

  // status 变更时重置列表
  useEffect(() => {
    setVotes([]);
    setPage(1);
    fetchVotes(1, false);
  }, [fetchVotes]);

  const hasMore = votes.length < total;

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      fetchVotes(page + 1, true);
    }
  }, [loading, hasMore, page, fetchVotes]);

  const refresh = useCallback(() => {
    setVotes([]);
    setPage(1);
    fetchVotes(1, false);
  }, [fetchVotes]);

  return { votes, total, loading, error, hasMore, loadMore, refresh };
}
