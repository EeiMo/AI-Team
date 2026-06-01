/**
 * src/middleware/errorHandler.ts
 * 职责：统一错误中间件 — catch 抛出的 AppError / 未知异常 → 归一化错误码 → JSON 响应
 */

import { Request, Response, NextFunction } from 'express';
import { ApiResponse } from '../types';

/** 业务异常，抛出时指定 code 和 message */
export class AppError extends Error {
  public readonly code: number;
  public readonly detail?: string;

  constructor(code: number, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = 'AppError';
  }
}

/** 统一错误处理中间件 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    const body: ApiResponse = {
      code: err.code,
      message: err.message,
    };
    if (err.detail) body.detail = err.detail;

    // 映射 AppError.code 到 HTTP 状态码
    const httpStatus = mapCodeToStatus(err.code);
    res.status(httpStatus).json(body);
    return;
  }

  // 未知异常 → 500
  console.error('[ErrorHandler] 未捕获异常:', err);
  res.status(500).json({
    code: 50000,
    message: '服务器内部错误',
  });
}

/** 业务错误码 → HTTP 状态码 */
function mapCodeToStatus(code: number): number {
  if (code >= 50000) return 500;
  if (code >= 42900) return 429;
  if (code >= 40900) return 409;
  if (code >= 40400) return 404;
  if (code >= 40300) return 403;
  if (code >= 40100) return 401;
  if (code >= 40000) return 400;
  return 500;
}
