/**
 * src/services/auditService.ts
 * 职责：审计日志写入服务
 *      - logDeleteVote: 记录删除投票操作日志
 */

import { knex } from '../db/knex';
import crypto from 'crypto';

/** UUID v7 — RFC 9562 时间有序 UUID */
function uuidV7(): string {
  const ms = Date.now();
  const rand = crypto.randomBytes(10);
  const tsHex = ms.toString(16).padStart(12, '0').slice(-12);
  const randAHex = (rand.readUInt16BE(0) & 0x0FFF).toString(16).padStart(3, '0');
  rand[2] = (rand[2] & 0x3F) | 0x80;
  const randBHex = rand.slice(2).toString('hex');
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8)}-7${randAHex}-${randBHex.slice(0, 4)}-${randBHex.slice(4)}`;
}

export interface LogDeleteVoteParams {
  entityId: string;
  userId: string;
  teamId: string;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown>;
}

/**
 * 审计日志服务
 */
export class AuditService {
  /**
   * 记录删除投票操作
   */
  async logDeleteVote(params: LogDeleteVoteParams): Promise<void> {
    const { entityId, userId, teamId, ip, userAgent, detail } = params;

    try {
      await knex('audit_logs').insert({
        id: uuidV7(),
        action: 'DELETE_VOTE',
        entity_type: 'vote',
        entity_id: entityId,
        user_id: userId,
        team_id: teamId,
        ip: ip || null,
        user_agent: userAgent || null,
        detail: JSON.stringify(detail),
        created_at: new Date().toISOString(),
      });
      console.info('[AuditService] 审计日志写入成功', { action: 'DELETE_VOTE', entityId, userId });
    } catch (err) {
      console.error('[AuditService] 审计日志写入失败:', err);
      // 审计日志写入失败不阻塞主流程，但抛给上层可被监控系统（如 Sentry）捕获
      throw err;
    }
  }
}
