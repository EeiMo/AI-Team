/**
 * types/index.ts
 * 共享类型定义：投票、选项、API 响应等核心数据结构
 * 与后端 API 契约对齐（ARCH v1.1 第四章）
 */

// ---- 投票选项 ----
export interface Option {
  id: string;
  content: string;
  sort_order: number;
  count?: number;
  voters?: Voter[];
}

// ---- 投票人信息 ----
export interface Voter {
  user_id: string;
  user_name: string;
}

// ---- 投票主数据 ----
export interface Vote {
  id: string;
  title: string;
  creator_id: string;
  creator_name: string;
  team_id: string;
  vote_type: VoteType;
  vote_mode: VoteMode;
  status: VoteStatus;
  deadline: string;
  total_voters: number;
  vote_count?: number;
  created_at: string;
  closed_at: string | null;
  closed_by: ClosedBy | null;
  options?: Option[];
}

// ---- 枚举类型 ----
export type VoteType = 'single' | 'multi';
export type VoteMode = 'anonymous' | 'public';
export type VoteStatus = 'active' | 'closed';
export type ClosedBy = 'manual' | 'auto';
export type ListStatus = 'active' | 'closed';

// ---- API 通用响应 ----
export interface ApiResponse<T = unknown> {
  code: number;
  message?: string;
  detail?: string;
  data?: T;
}

// ---- 投票列表响应 ----
export interface VoteListData {
  items: Vote[];
  total: number;
  page: number;
  size: number;
}

// ---- 投票详情响应 ----
export interface VoteDetailData {
  vote: Vote;
  has_voted: boolean;
  my_selected_options: string[];
}

// ---- 创建投票请求体 ----
export interface CreateVoteRequest {
  title: string;
  options: string[];
  vote_type: VoteType;
  vote_mode: VoteMode;
  deadline_minutes: number;
  /** 预期投票总人数，0=不限制（不显示进度条） */
  total_voters?: number;
}

// ---- 创建投票响应 ----
export interface CreateVoteResponse {
  vote: Vote;
}

// ---- 提交投票请求体 ----
export interface SubmitVoteRequest {
  option_ids: string[];
}

// ---- 提交投票响应 ----
export interface SubmitVoteResponse {
  vote_id: string;
  selected_options: string[];
  submitted_at: string;
}

// ---- 结束投票响应 ----
export interface CloseVoteResponse {
  vote_id: string;
  status: 'closed';
  closed_by: ClosedBy;
  closed_at: string;
}

// ---- WS 推送事件 Payload ----
export interface WsVoteUpdate {
  option_id: string;
  new_count: number;
  total_votes: number;
}

export interface WsVoteClosed {
  closed_by: ClosedBy;
  closed_at: string;
}

export interface WsReminder {
  remaining_seconds: number;
}

// ---- 表单校验结果 ----
export interface ValidationError {
  field: string;
  message: string;
}

// ---- 倒计时状态 ----
export interface CountdownState {
  remaining: number;       // 剩余秒数
  isExpired: boolean;
  isWarning: boolean;      // ≤60s
  isCritical: boolean;     // ≤10s
}
