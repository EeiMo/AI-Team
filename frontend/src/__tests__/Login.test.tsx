/**
 * __tests__/Login.test.tsx
 * 飞书 SSO 登录 + dev 降级模式单元测试
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Login from '../pages/Login';

// Mock react-router-dom
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

describe('Login — 登录页', () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockClear();
  });

  // UT-LG-01: SSO 按钮渲染
  it('UT-LG-01: SSO 模式下显示飞书登录按钮', () => {
    // VITE_AUTH_MODE is 'sso' by default
    render(<Login />);
    expect(screen.getByText('飞书登录')).toBeInTheDocument();
  });

  // UT-LG-02: 标题渲染
  it('UT-LG-02: 显示标题「团队即时投票」', () => {
    render(<Login />);
    expect(screen.getByText('团队即时投票')).toBeInTheDocument();
  });

  // UT-LG-03: dev 降级入口
  it('UT-LG-03: SSO 模式下显示「开发人员入口」折叠按钮', () => {
    render(<Login />);
    expect(screen.getByText('开发人员入口')).toBeInTheDocument();
  });

  // UT-LG-04: 展开 dev 表单
  it('UT-LG-04: 点击「开发人员入口」展开手动登录表单', async () => {
    render(<Login />);
    fireEvent.click(screen.getByText('开发人员入口'));
    await waitFor(() => {
      expect(screen.getByText('手动登录')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('例如：zhangsan')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('例如：张三')).toBeInTheDocument();
      expect(screen.getByText('进入投票')).toBeInTheDocument();
    });
  });

  // UT-LG-05: dev 登录 — 空用户 ID 校验
  it('UT-LG-05: dev 登录时用户 ID 为空 → 显示错误', async () => {
    render(<Login />);
    fireEvent.click(screen.getByText('开发人员入口'));
    await waitFor(() => screen.getByText('进入投票'));

    fireEvent.click(screen.getByText('进入投票'));
    await waitFor(() => {
      expect(screen.getByText('请输入用户 ID')).toBeInTheDocument();
    });
  });

  // UT-LG-06: dev 登录 — 空昵称校验
  it('UT-LG-06: dev 登录时昵称为空 → 显示错误', async () => {
    render(<Login />);
    fireEvent.click(screen.getByText('开发人员入口'));
    await waitFor(() => screen.getByText('进入投票'));

    await userEvent.type(screen.getByPlaceholderText('例如：zhangsan'), 'testuser');
    fireEvent.click(screen.getByText('进入投票'));
    await waitFor(() => {
      expect(screen.getByText('请输入昵称')).toBeInTheDocument();
    });
  });

  // UT-LG-07: dev 登录成功 → 存储 token 并跳转
  it('UT-LG-07: dev 登录成功 → 存储 token + 跳转到 /votes', async () => {
    render(<Login />);
    fireEvent.click(screen.getByText('开发人员入口'));
    await waitFor(() => screen.getByText('进入投票'));

    await userEvent.type(screen.getByPlaceholderText('例如：zhangsan'), 'testuser');
    await userEvent.type(screen.getByPlaceholderText('例如：张三'), '测试用户');
    fireEvent.click(screen.getByText('进入投票'));

    await waitFor(() => {
      expect(localStorage.getItem('feishu_token')).toBe('dev_testuser_default_测试用户');
      expect(localStorage.getItem('feishu_user_id')).toBe('testuser');
      expect(localStorage.getItem('feishu_display_name')).toBe('测试用户');
      expect(mockNavigate).toHaveBeenCalledWith('/votes', { replace: true });
    });
  });

  // UT-LG-08: 用户 ID 长度校验（64字符允许，>64被截断）
  it('UT-LG-08: 用户 ID 允许 64 字符（input maxLength 截断）', async () => {
    render(<Login />);
    fireEvent.click(screen.getByText('开发人员入口'));
    await waitFor(() => screen.getByText('进入投票'));

    // input maxLength=64 限制物理输入；但程序仍然校验长度
    const input = screen.getByPlaceholderText('例如：zhangsan');
    // 绕过 maxLength 通过直接设置 value 模拟攻击场景
    await userEvent.clear(input);
    fireEvent.change(input, { target: { value: 'a'.repeat(65) } });
    await userEvent.type(screen.getByPlaceholderText('例如：张三'), '测试用户');
    fireEvent.click(screen.getByText('进入投票'));

    await waitFor(() => {
      expect(screen.getByText('用户 ID 不超过 64 个字符')).toBeInTheDocument();
    });
  });
});
