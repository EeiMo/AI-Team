/**
 * store/index.ts
 * Zustand 全局状态：网络连接态、投票列表筛选
 */
import { create } from 'zustand';
import type { ListStatus } from '../types';

// ---- 网络连接状态 ----
interface NetworkState {
  isConnected: boolean;
  isDegraded: boolean;        // WS 断线
  setConnected: (v: boolean) => void;
  setDegraded: (v: boolean) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  isConnected: true,
  isDegraded: false,
  setConnected: (v) => set({ isConnected: v }),
  setDegraded: (v) => set({ isDegraded: v }),
}));

// ---- 列表筛选状态 ----
interface FilterState {
  status: ListStatus;
  setStatus: (s: ListStatus) => void;
}

export const useFilterStore = create<FilterState>((set) => ({
  status: 'active',
  setStatus: (s) => set({ status: s }),
}));
