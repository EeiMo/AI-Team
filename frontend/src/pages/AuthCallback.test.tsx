/**
 * pages/AuthCallback.test.tsx
 * 飞书 OAuth 回调页测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AuthCallback from '../pages/AuthCallback';
import * as api from '../services/api';

// Mock api module
vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
  return {
    ...actual,
    feishuCallback: vi.fn(),
  };
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderCallback(searchParams: string, initialRoute = '/auth/callback') {
  window.history.pushState({}, '', `${initialRoute}${searchParams}`);
  return render(
    <MemoryRouter initialEntries={[`${initialRoute}${searchParams}`]}>
      <AuthCallback />
    </MemoryRouter>
  );
}

describe('AuthCallback', () => {
  it('缺少 code 参数时显示错误', async () => {
    renderCallback('?state=abc123');
    await waitFor(() => {
      expect(screen.getByText('授权参数缺失，请重新登录')).toBeInTheDocument();
    });
  });

  it('缺少 state 参数时显示错误', async () => {
    renderCallback('?code=xyz789');
    await waitFor(() => {
      expect(screen.getByText('授权参数缺失，请重新登录')).toBeInTheDocument();
    });
  });

  it('无参数时显示错误', async () => {
    renderCallback('');
    await waitFor(() => {
      expect(screen.getByText('授权参数缺失，请重新登录')).toBeInTheDocument();
    });
  });

  it('有效 code+state 调用后端回调 API', async () => {
    const mockCallback = api.feishuCallback as ReturnType<typeof vi.fn>;
    mockCallback.mockResolvedValueOnce({
      token: 'feishu_test_token_123',
      user_id: 'ou_abc',
      display_name: '张三',
      avatar_url: 'https://example.com/avatar.png',
    });

    renderCallback('?code=valid_code&state=valid_state');

    await waitFor(() => {
      expect(mockCallback).toHaveBeenCalledWith('valid_code', 'valid_state');
      expect(localStorage.getItem('feishu_token')).toBe('feishu_test_token_123');
      expect(localStorage.getItem('feishu_user_id')).toBe('ou_abc');
      expect(localStorage.getItem('feishu_display_name')).toBe('张三');
      expect(localStorage.getItem('feishu_avatar_url')).toBe('https://example.com/avatar.png');
    });
  });

  it('回调 API 失败时显示错误信息', async () => {
    const mockCallback = api.feishuCallback as ReturnType<typeof vi.fn>;
    mockCallback.mockRejectedValueOnce(new Error('飞书授权已过期'));

    renderCallback('?code=expired&state=abc');

    await waitFor(() => {
      expect(screen.getByText('飞书授权已过期')).toBeInTheDocument();
    });
  });

  it('无 avatar_url 时不存储该字段', async () => {
    const mockCallback = api.feishuCallback as ReturnType<typeof vi.fn>;
    mockCallback.mockResolvedValueOnce({
      token: 'feishu_token_no_avatar',
      user_id: 'ou_xyz',
      display_name: '李四',
    });

    renderCallback('?code=code2&state=state2');

    await waitFor(() => {
      expect(localStorage.getItem('feishu_token')).toBe('feishu_token_no_avatar');
      expect(localStorage.getItem('feishu_user_id')).toBe('ou_xyz');
      expect(localStorage.getItem('feishu_display_name')).toBe('李四');
      expect(localStorage.getItem('feishu_avatar_url')).toBeNull();
    });
  });

  it('显示返回登录按钮在错误页面上', async () => {
    renderCallback('?code=bad&state=bad');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /返回登录/i })).toBeInTheDocument();
    });
  });

  it('加载中显示 loading 文案', async () => {
    const mockCallback = api.feishuCallback as ReturnType<typeof vi.fn>;
    // 永不 resolve 的 promise 保持 loading 状态
    mockCallback.mockImplementationOnce(() => new Promise(() => {}));

    renderCallback('?code=pending&state=pending');

    // 组件应立即显示 loading
    expect(screen.getByText('飞书登录中…')).toBeInTheDocument();
  });
});
