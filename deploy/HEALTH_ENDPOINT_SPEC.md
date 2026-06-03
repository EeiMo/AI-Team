# Health Endpoint 规范

- **设计人**：长夜
- **日期**：2026-06-01
- **进化版本**：evo-v1 | 来源：EVO-006 health 端点规范
- **受众**：凌霜（后端实现）

---

## 1. 端点定义

| 项目 | 值 |
|------|-----|
| 方法 | `GET` |
| 路径 | `/health` |
| 认证 | 无需认证（内网访问 / Nginx 反代） |
| Content-Type | `application/json` |
| 成功状态码 | `200 OK` |
| 失败状态码 | `503 Service Unavailable` |

---

## 2. 响应格式

### 2.1 健康（200）

```json
{
  "status": "ok",
  "uptime": 3600,
  "timestamp": "2026-06-01T12:00:00.000Z",
  "version": "1.0.0",
  "checks": {
    "database": {
      "status": "ok",
      "latency_ms": 2
    },
    "redis": {
      "status": "ok",
      "latency_ms": 1
    }
  }
}
```

### 2.2 不健康（503）

```json
{
  "status": "error",
  "uptime": 3600,
  "timestamp": "2026-06-01T12:00:00.000Z",
  "version": "1.0.0",
  "checks": {
    "database": {
      "status": "error",
      "message": "connect ECONNREFUSED 172.18.0.3:5432"
    },
    "redis": {
      "status": "ok",
      "latency_ms": 1
    }
  }
}
```

---

## 3. 检查项说明

| 检查项 | 方法 | 要求 |
|--------|------|------|
| `database` | 执行 `SELECT 1` 或等价的轻量查询 | 若 PG 不可达或查询超时（>3s），标记 `error` |
| `redis` | 执行 `PING` 命令 | 若 Redis 不可达或超时（>1s），标记 `error` |

### 优先级

- **必须**：database、redis（Docker Compose `depends_on` 依赖这两项）
- **可选**（后续迭代）：飞书 API 连通性、磁盘空间、内存占用

---

## 4. 实现建议

```typescript
// 伪代码
app.get('/health', async (req, res) => {
  const checks: Record<string, HealthCheck> = {};

  // DB 检查
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    checks.database = { status: 'ok', latency_ms: Date.now() - start };
  } catch (e) {
    checks.database = { status: 'error', message: e.message };
  }

  // Redis 检查
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = { status: 'ok', latency_ms: Date.now() - start };
  } catch (e) {
    checks.redis = { status: 'error', message: e.message };
  }

  const allOk = Object.values(checks).every(c => c.status === 'ok');
  const statusCode = allOk ? 200 : 503;

  res.status(statusCode).json({
    status: allOk ? 'ok' : 'error',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || '0.0.0',
    checks,
  });
});
```

---

## 5. 消费者

| 消费者 | 用途 | 频率 |
|--------|------|------|
| Docker healthcheck（app 容器） | 容器健康状态判定，不健康则自动重启 | 每 15s |
| Docker healthcheck（nginx 容器） | 反代层健康判定 | 每 30s |
| 冒烟测试（smoke-test.sh） | 部署后验证 | 每次部署后 |
| 监控系统（后续） | 可用性告警 | 每 30s |

---

## 6. 与 Docker 集成

`/health` 端点在以下位置被消费：

1. **`docker-compose.yml` 的 app 服务 healthcheck**：
   ```yaml
   healthcheck:
     test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
     interval: 15s
     timeout: 5s
     retries: 3
   ```

2. **`app.Dockerfile` 的 HEALTHCHECK 指令**（容器内自检）：
   ```dockerfile
   HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
     CMD curl -f http://localhost:3001/health || exit 1
   ```

3. **Nginx 反代**：`/health` 路径不记 access_log，直接代理到 app：
   ```nginx
   location /health {
       access_log off;
       proxy_pass http://vote_app/health;
   }
   ```

---

## 7. 注意事项

- **性能**：健康检查频繁（每 15s），务必保持轻量。不可执行复杂查询。
- **超时**：各检查项设置超时上限：DB 3s、Redis 1s。任一超时即标记 error。
- **无副作用**：`SELECT 1` / `PING` 不产生写入。
- **日志**：健康检查成功响应不计入应用日志，避免日志膨胀。仅错误时记录。
