/**
 * hooks/useSocket.ts
 * Socket.IO 客户端封装：连接/断开/重连、房间 join/leave、事件监听
 *
 * 与 ARCH v1.1 §7 对齐：
 * - 连接时 send join:vote
 * - 监听 vote:{id}:update / vote:{id}:closed / vote:{id}:reminder
 * - 断开时更新全局降级状态
 */
import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useNetworkStore } from '../store';
import type { WsVoteUpdate, WsVoteClosed, WsVoteDeleted, WsReminder } from '../types';

interface UseSocketOptions {
  voteId: string;
  onUpdate?: (payload: WsVoteUpdate) => void;
  onClosed?: (payload: WsVoteClosed) => void;
  onDeleted?: (payload: WsVoteDeleted) => void;
  onReminder?: (payload: WsReminder) => void;
  onReconnect?: () => void;
}

export function useSocket({ voteId, onUpdate, onClosed, onDeleted, onReminder, onReconnect }: UseSocketOptions) {
  const socketRef = useRef<Socket | null>(null);
  const { setConnected, setDegraded } = useNetworkStore();
  const callbacksRef = useRef({ onUpdate, onClosed, onDeleted, onReminder, onReconnect });

  // 保持回调引用最新，避免 useEffect 重复绑定
  callbacksRef.current = { onUpdate, onClosed, onDeleted, onReminder, onReconnect };

  useEffect(() => {
    const token = localStorage.getItem('feishu_token') ?? '';
    const socket: Socket = io('/ws', {
      path: '/ws',
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      timeout: 10000,
    });

    socketRef.current = socket;

    // ---- 连接成功 → 加入房间 ----
    socket.on('connect', () => {
      setConnected(true);
      setDegraded(false);
      socket.emit('join:vote', { vote_id: voteId });
    });

    // ---- 断线 → 降级标记 ----
    socket.on('disconnect', () => {
      setConnected(false);
      setDegraded(true);
    });

    // ---- 重连中 ----
    socket.on('reconnect_attempt', () => {
      setDegraded(true);
    });

    // ---- 重连成功 ----
    socket.on('reconnect', () => {
      setConnected(true);
      setDegraded(false);
      socket.emit('join:vote', { vote_id: voteId });
      // 重连后通知上层全量拉取最新数据
      callbacksRef.current.onReconnect?.();
    });

    // ---- 投票更新事件 ----
    socket.on(`vote:${voteId}:update`, (payload: WsVoteUpdate) => {
      callbacksRef.current.onUpdate?.(payload);
    });

    // ---- 投票结束事件 ----
    socket.on(`vote:${voteId}:closed`, (payload: WsVoteClosed) => {
      callbacksRef.current.onClosed?.(payload);
    });

    // ---- 投票删除事件 ----
    socket.on(`vote:${voteId}:deleted`, (payload: WsVoteDeleted) => {
      callbacksRef.current.onDeleted?.(payload);
    });

    // ---- 截止提醒事件 ----
    socket.on(`vote:${voteId}:reminder`, (payload: WsReminder) => {
      callbacksRef.current.onReminder?.(payload);
    });

    // ---- 清理 ----
    return () => {
      socket.emit('leave:vote', { vote_id: voteId });
      socket.off('connect');
      socket.off('disconnect');
      socket.off('reconnect_attempt');
      socket.off('reconnect');
      socket.off(`vote:${voteId}:update`);
      socket.off(`vote:${voteId}:closed`);
      socket.off(`vote:${voteId}:deleted`);
      socket.off(`vote:${voteId}:reminder`);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [voteId, setConnected, setDegraded]);

  // ---- 暴露手动 emit join（重连后调用） ----
  const rejoin = useCallback(() => {
    socketRef.current?.emit('join:vote', { vote_id: voteId });
  }, [voteId]);

  return { socketRef, rejoin };
}
