/**
 * pages/Login.test.tsx
 * 飞书 SSO + dev 降级登录页的单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from '../pages/Login';

// Mock window.location.href for SSO redirect test
const mockLocationHref = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('open', vi.fn());
  Object.defineProperty(window, 'location', {
    value: { href: '' },
    writable: true,
  });
  // Reset env before each test
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function renderLogin(initialRoute = '/login') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Login />
    </MemoryRouter>
  );
}

describe('Login — SSO 模式 (VITE_AUTH_MODE=sso)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'sso');
  });

  it('渲染飞书登录按钮', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: /飞书登录/i })).toBeInTheDocument();
  });

  it('渲染标题和副标题', () => {
    renderLogin();
    expect(screen.getByText('团队即时投票')).toBeInTheDocument();
    expect(screen.getByText('使用飞书账号一键登录')).toBeInTheDocument();
  });

  it('点击飞书登录按钮触发 SSO 跳转', async () => {
    renderLogin();
    const btn = screen.getByRole('button', { name: /飞书登录/i });

    // 记录 href 赋值
    let redirectedTo = '';
    Object.defineProperty(window, 'location', {
      value: {
        get href() {
          return redirectedTo;
        },
        set href(val: string) {
          redirectedTo = val;
        },
      },
      writable: true,
    });

    await userEvent.click(btn);
    expect(redirectedTo).toBe('/api/auth/feishu/redirect');
  });

  it('默认隐藏 dev 手动登录区域', () => {
    renderLogin();
    expect(screen.queryByText('手动登录')).not.toBeInTheDocument();
  });

  it('点击"开发人员入口"展开 dev 手动登录', async () => {
    renderLogin();
    const toggleBtn = screen.getByRole('button', { name: /开发人员入口/i });
    await userEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText('手动登录')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('例如：zhangsan')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('例如：张三')).toBeInTheDocument();
    });
  });

  it('展开 dev 后可通过手动登录进入投票', async () => {
    renderLogin();
    // 展开 dev 登录
    await userEvent.click(screen.getByRole('button', { name: /开发人员入口/i }));

    await userEvent.type(screen.getByPlaceholderText('例如：zhangsan'), 'testuser');
    await userEvent.type(screen.getByPlaceholderText('例如：张三'), '测试用户');

    await userEvent.click(screen.getByRole('button', { name: /进入投票/i }));

    expect(localStorage.getItem('feishu_token')).toBe('dev_testuser_default_测试用户');
    expect(localStorage.getItem('feishu_user_id')).toBe('testuser');
    expect(localStorage.getItem('feishu_display_name')).toBe('测试用户');
  });

  it('展开 dev 后 ID 为空显示错误', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: /开发人员入口/i }));
    await userEvent.click(screen.getByRole('button', { name: /进入投票/i }));

    expect(screen.getByText('请输入用户 ID')).toBeInTheDocument();
  });

  it('展开 dev 后昵称为空显示错误', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: /开发人员入口/i }));
    await userEvent.type(screen.getByPlaceholderText('例如：zhangsan'), 'testuser');
    await userEvent.click(screen.getByRole('button', { name: /进入投票/i }));

    expect(screen.getByText('请输入昵称')).toBeInTheDocument();
  });

  it('点击"收起"隐藏 dev 登录区域', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: /开发人员入口/i }));
    await userEvent.click(screen.getByRole('button', { name: /收起/i }));

    expect(screen.queryByText('手动登录')).not.toBeInTheDocument();
  });
});

describe('Login — dev 模式 (VITE_AUTH_MODE=dev)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'dev');
  });

  it('默认显示手动登录表单', () => {
    renderLogin();
    expect(screen.getByText('手动登录')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例如：zhangsan')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例如：张三')).toBeInTheDocument();
  });

  it('不显示飞书登录按钮', () => {
    renderLogin();
    expect(screen.queryByRole('button', { name: /飞书登录/i })).not.toBeInTheDocument();
  });

  it('不显示"开发人员入口"切换按钮', () => {
    renderLogin();
    expect(screen.queryByRole('button', { name: /开发人员入口/i })).not.toBeInTheDocument();
  });

  it('副标题显示"输入身份信息开始使用"', () => {
    renderLogin();
    expect(screen.getByText('输入身份信息开始使用')).toBeInTheDocument();
  });

  it('手动提交 dev token 并跳转', async () => {
    renderLogin();

    await userEvent.type(screen.getByPlaceholderText('例如：zhangsan'), 'dev001');
    await userEvent.type(screen.getByPlaceholderText('例如：张三'), '李四');

    await userEvent.click(screen.getByRole('button', { name: /进入投票/i }));

    expect(localStorage.getItem('feishu_token')).toBe('dev_dev001_default_李四');
    expect(localStorage.getItem('feishu_user_id')).toBe('dev001');
    expect(localStorage.getItem('feishu_display_name')).toBe('李四');
  });

  it('用户 ID 超过 64 字符显示错误', async () => {
    renderLogin();
    const longId = 'a'.repeat(65);

    // 直接设置 value 绕过 input 的 maxLength 限制
    const idInput = screen.getByPlaceholderText('例如：zhangsan');
    fireEvent.change(idInput, { target: { value: longId } });
    await userEvent.type(screen.getByPlaceholderText('例如：张三'), '测试');
    await userEvent.click(screen.getByRole('button', { name: /进入投票/i }));

    expect(screen.getByText('用户 ID 不超过 64 个字符')).toBeInTheDocument();
  });
});
