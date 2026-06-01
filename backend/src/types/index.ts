/**
 * src/types/index.ts
 * 职责：共享类型定义 — Vote / Option / UserVote / ApiResponse / WS 事件 Payload
 */

// ---- 数据库行类型 ----

/** 投票主表行 */
export interface VoteRow {
  id: string;
  title: string;
  creator_id: string;
  creator_name: string;
  team_id: string;
  vote_type: VoteType;
  vote_mode: VoteMode;
  status: VoteStatus;
  deadline: string; // ISO 8601
  total_voters: number;
  created_at: string;
  closed_at: string | null;
  closed_by: ClosedBy | null;
}

/** 选项表行 */
export interface OptionRow {
  id: string;
  vote_id: string;
  content: string;
  sort_order: number;
}

/** 用户投票记录表行 */
export interface UserVoteRow {
  id: string;
  vote_id: string;
  user_id: string;
  selected_options: string[];
  created_at: string;
}

// ---- 枚举 ----

export type VoteType = 'single' | 'multi';
export type VoteMode = 'anonymous' | 'public';
export type VoteStatus = 'active' | 'closed';
export type ClosedBy = 'manual' | 'auto';

// ---- API 请求体 ----

export interface CreateVoteBody {
  title: string;
  options: string[];
  vote_type: VoteType;
  vote_mode: VoteMode;
  deadline_minutes: number;
  /** BUG-007 修复：幂等键，同一 user_id + key 重复请求返回缓存结果（TTL 24h） */
  idempotency_key?: string;
}

export interface SubmitVoteBody {
  option_ids: string[];
  /** BUG-007 修复：幂等键，同一 user_id + key 重复请求返回缓存结果（TTL 24h） */
  idempotency_key?: string;
}

export interface VoteListQuery {
  status?: VoteStatus;
  page?: number;
  size?: number;
}

// ---- 选项（含票数） ----

/** API 返回的选项（含票数、投票人） */
export interface OptionWithTally {
  id: string;
  content: string;
  sort_order: number;
  count: number;
  voters: VoterInfo[];
}

export interface VoterInfo {
  user_id: string;
  user_name: string;
}

// ---- API 响应 Data ----

export interface VoteResponse {
  vote: VoteRow & {
    options: OptionRow[];
  };
}

export interface VoteListItem {
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
  vote_count: number;
  created_at: string;
}

export interface VoteListResponse {
  items: VoteListItem[];
  total: number;
  page: number;
  size: number;
}

export interface VoteDetailResponse {
  vote: VoteRow & {
    options: OptionWithTally[];
  };
  has_voted: boolean;
  my_selected_options: string[];
}

export interface SubmitVoteResponse {
  vote_id: string;
  selected_options: string[];
  submitted_at: string;
}

export interface CloseVoteResponse {
  vote_id: string;
  status: VoteStatus;
  closed_by: ClosedBy;
  closed_at: string;
}

// ---- 通用 API 响应 ----

export interface ApiResponse<T = unknown> {
  code: number;
  message?: string;
  detail?: string;
  data?: T;
}

// ---- WS 事件 Payload ----

export interface WsVoteUpdatePayload {
  option_id: string;
  new_count: number;
  total_votes: number;
}

export interface WsVoteClosedPayload {
  closed_by: ClosedBy;
  closed_at: string;
}

export interface WsVoteReminderPayload {
  remaining_seconds: number;
}

// ---- Express 扩展 ----

declare global {
  namespace Express {
    interface Request {
      user?: {
        user_id: string;
        team_id: string;
        display_name: string;
      };
    }
  }
}

// ---- Socket.IO 扩展 ----

export interface SocketAuthPayload {
  token: string;
}

export interface SocketAuthData {
  user_id: string;
  team_id: string;
  display_name: string;
}

// Server-to-client events
export interface ServerToClientEvents {
  ['vote:{id}:update']: (payload: WsVoteUpdatePayload) => void;
  ['vote:{id}:closed']: (payload: WsVoteClosedPayload) => void;
  ['vote:{id}:reminder']: (payload: WsVoteReminderPayload) => void;
}

// Client-to-server events
export interface ClientToServerEvents {
  'join:vote': (payload: { vote_id: string }) => void;
  'leave:vote': (payload: { vote_id: string }) => void;
}
