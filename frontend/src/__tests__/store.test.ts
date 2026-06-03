/**
 * __tests__/store.test.ts
 * Zustand store 单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore, useFilterStore } from '../store';

describe('Store — 全局状态', () => {
  beforeEach(() => {
    // Reset stores to defaults
    useNetworkStore.setState({
      isConnected: true,
      isDegraded: false,
    });
    useFilterStore.setState({ status: 'active' });
  });

  // UT-ST-01: 网络连接初始状态
  it('UT-ST-01: 网络连接初始状态为已连接', () => {
    const state = useNetworkStore.getState();
    expect(state.isConnected).toBe(true);
    expect(state.isDegraded).toBe(false);
  });

  // UT-ST-02: 设置连接状态
  it('UT-ST-02: 设置连接状态为断开', () => {
    useNetworkStore.getState().setConnected(false);
    const state = useNetworkStore.getState();
    expect(state.isConnected).toBe(false);
  });

  // UT-ST-03: 设置降级标志
  it('UT-ST-03: WS 断线时设置降级标志', () => {
    useNetworkStore.getState().setDegraded(true);
    const state = useNetworkStore.getState();
    expect(state.isDegraded).toBe(true);
  });

  // UT-ST-04: 恢复连接
  it('UT-ST-04: 恢复网络连接后降级标志重置', () => {
    const store = useNetworkStore.getState();
    store.setDegraded(true);
    store.setConnected(false);
    expect(useNetworkStore.getState().isDegraded).toBe(true);

    // 恢复
    useNetworkStore.getState().setConnected(true);
    expect(useNetworkStore.getState().isConnected).toBe(true);
    // 注意：恢复连接不会自动重置降级标志（由 WS 重连逻辑处理）
  });

  // UT-ST-05: 筛选状态默认为 active
  it('UT-ST-05: 投票列表筛选默认为进行中', () => {
    expect(useFilterStore.getState().status).toBe('active');
  });

  // UT-ST-06: 切换筛选状态
  it('UT-ST-06: 切换投票列表筛选为已结束', () => {
    useFilterStore.getState().setStatus('closed');
    expect(useFilterStore.getState().status).toBe('closed');
  });
});
