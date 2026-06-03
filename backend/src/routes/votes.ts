/**
 * src/routes/votes.ts
 * 职责：投票 REST 路由
 *      - POST   /api/votes          创建投票
 *      - GET    /api/votes          投票列表
 *      - GET    /api/votes/:id      投票详情
 *      - POST   /api/votes/:id/vote 提交投票
 *      - POST   /api/votes/:id/close 结束投票
 */

import { Router, Request, Response, NextFunction } from 'express';
import { VoteService } from '../services/voteService';
import { BallotService } from '../services/ballotService';
import { DeleteService } from '../services/deleteService';
import { config } from '../config';

export function createVoteRouter(
  voteService: VoteService,
  ballotService: BallotService,
  deleteService?: DeleteService
): Router {
  const router = Router();

  // ---- 通用：确保 req.user 存在 ----
  function requireUser(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ code: 40100, message: '未登录或登录已过期，请重新登录' });
      return;
    }
    next();
  }

  // ---- 获取 total_voters（表单优先 → 环境变量） ----
  function getTotalVoters(body?: { total_voters?: number }): number {
    if (body?.total_voters && body.total_voters > 0) return body.total_voters;
    return config.TEAM_TOTAL_MEMBERS > 0 ? config.TEAM_TOTAL_MEMBERS : 0;
  }

  // ============================================================
  // POST /api/votes — 创建投票
  // ============================================================
  router.post('/', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id, team_id, display_name } = req.user!;
      const result = await voteService.createVote(
        req.body,
        user_id,
        display_name,
        team_id,
        getTotalVoters(req.body)
      );
      res.status(201).json({ code: 0, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================
  // GET /api/votes — 投票列表
  // ============================================================
  router.get('/', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { team_id } = req.user!;
      const result = await voteService.listVotes(team_id, {
        status: (req.query.status as 'active' | 'closed') || 'active',
        page: parseInt(req.query.page as string, 10) || 1,
        size: parseInt(req.query.size as string, 10) || 20,
      });
      res.json({ code: 0, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================
  // GET /api/votes/:id — 投票详情
  // ============================================================
  router.get('/:id', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.user!;
      const result = await voteService.getVoteDetail(req.params.id, user_id);
      res.json({ code: 0, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================
  // POST /api/votes/:id/vote — 提交投票
  // ============================================================
  router.post('/:id/vote', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.user!;
      const result = await ballotService.submitVote(req.params.id, user_id, req.body);
      res.json({ code: 0, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================
  // POST /api/votes/:id/close — 结束投票
  // ============================================================
  router.post('/:id/close', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id, team_id } = req.user!;
      const result = await voteService.closeVote(req.params.id, user_id, team_id);
      res.json({ code: 0, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================
  // DELETE /api/votes/:id — 删除投票（软删除）
  // ============================================================
  router.delete('/:id', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deleteService) {
        res.status(500).json({ code: 50000, message: '删除服务未初始化' });
        return;
      }
      const { user_id, team_id } = req.user!;
      const ip = req.ip || req.socket.remoteAddress || null;
      const userAgent = req.headers['user-agent'] || null;

      await deleteService.deleteVote(
        req.params.id,
        user_id,
        team_id,
        ip,
        userAgent
      );
      res.json({ code: 0, message: '投票已删除' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
