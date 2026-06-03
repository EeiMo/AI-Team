# 自托管 Runner 部署报告

**设计人**：长夜🚀（运维）  
**日期**：2026-06-02  
**项目**：团队即时投票工具（EeiMo/AI-Team）  
**仓库**：`git@github.com:EeiMo/AI-Team.git`

---

## 1. Runner 版本和架构

| 项目 | 值 |
|------|-----|
| **Runner 版本** | v2.334.0 |
| **系统架构** | `x86_64` (Linux amd64) |
| **操作系统** | Ubuntu Linux |
| **Docker 版本** | 29.3.1（snap 安装） |
| **Node.js** | v24.16.0 |
| **npm** | 11.13.0 |

## 2. 安装路径

| 内容 | 路径 |
|------|------|
| **Runner 安装目录** | `/home/eeimoo/actions-runner/` |
| **Runner 可执行文件** | `/home/eeimoo/actions-runner/bin/` |
| **配置文件** | `/home/eeimoo/actions-runner/.config/`（注册后生成） |
| **环境变量** | `/home/eeimoo/actions-runner/.env` |
| **服务文件** | `/etc/systemd/system/actions.runner.*.service`（注册后生成） |

## 3. 服务状态

```
❌ Runner 尚未注册，服务未启动
```

Runner 已下载并解压，**但尚未注册到 GitHub**（需要老板手动提供注册 token，详见下文"老板后续操作清单"）。

## 4. ci.yml 修改摘要

### 4.1 变更总览

| 序号 | 变更内容 | 说明 |
|------|---------|------|
| ① | 所有 job 的 `runs-on` 改为 `[self-hosted, linux, x64]` | 从 GitHub 托管 Runner 切换到自托管 |
| ② | **删除**两个 SSH deploy job（`appleboy/ssh-action`） | 不再需要 SSH secrets |
| ③ | **替换** `deploy-staging` | 改为本机执行 docker compose + 冒烟测试 |
| ④ | **替换** `deploy-production` | 改为本机执行 docker compose（保留 Environment 审批流程） |
| ⑤ | **替换** production 回滚脚本 | 移除 SSH，改为本机 `run:` |
| ⑥ | **删除**所有的 `${{ secrets.STAGING_* }}` 和 `${{ secrets.PROD_* }}` | 不再依赖 GitHub Secrets |
| ⑦ | **Docker login** 改用 `${{ env.* }}` | 凭据在 runner 本机 `.env` 中配置 |
| ⑧ | 新增 `GHCR_USERNAME/GHCR_TOKEN/ACR_USERNAME/ACR_PASSWORD` 环境变量 | 需要在 runner `.env` 中填入真实值 |

### 4.2 删除的 Secrets 依赖（共 8 个）

以下 GitHub Secrets **不再需要**，可以从 GitHub → Settings → Secrets 中删除：

- ❌ `PROD_SSH_HOST`
- ❌ `PROD_SSH_USER`
- ❌ `PROD_SSH_KEY`
- ❌ `STAGING_SSH_HOST`
- ❌ `STAGING_SSH_USER`
- ❌ `STAGING_SSH_KEY`
- ❌ `STAGING_ENV_FILE`

以下 Secrets **已转为 runner 本地环境变量**：

- ⚠️ `GHCR_USERNAME` → 放入 `/home/eeimoo/actions-runner/.env`
- ⚠️ `GHCR_TOKEN` → 放入 `/home/eeimoo/actions-runner/.env`
- ⚠️ `ACR_USERNAME` → 放入 `/home/eeimoo/actions-runner/.env`
- ⚠️ `ACR_PASSWORD` → 放入 `/home/eeimoo/actions-runner/.env`

### 4.3 保留的 Secrets

以下仍受 GitHub Environments 保护，保留在 GitHub 端：

- **production 环境**：GitHub Environment 审批保护（Required Reviewers）
- 但不再使用 SSH，审批通过后部署命令在本地 runner 上直接执行

### 4.4 部署目录

| 环境 | 部署目录 |
|------|---------|
| Staging | `/home/eeimoo/vote-app-staging/` |
| Production | `/home/eeimoo/vote-app-prod/` |

---

## 5. 老板后续操作清单

### 必须操作（5 步）

1. **配置 Docker 镜像仓库凭据**
   - 编辑 `/home/eeimoo/actions-runner/.env`
   - 填入真实的 `GHCR_TOKEN`、`ACR_USERNAME`、`ACR_PASSWORD`
   - GHCR_TOKEN 需要有 `read:packages` + `write:packages` 权限

2. **注册 Runner 到 GitHub**
   - 前往 GitHub → [EeiMo/AI-Team](https://github.com/EeiMo/AI-Team) → Settings → Actions → Runners → **New self-hosted runner**
   - 选择 **Linux** → **x64**
   - 复制页面底部显示的 `--token <TOKEN>` 值
   - 在终端执行：
     ```bash
     cd /home/eeimoo/actions-runner
     ./config.sh --url https://github.com/EeiMo/AI-Team --token <复制的token>
     ```
   - 配置时，**推荐**：
     - Runner name: `eeimoo-local-runner`
     - Labels: `self-hosted,linux,x64`（回车使用默认）
     - Work folder: `_work`（回车使用默认）

3. **启动 Runner 服务**
   ```bash
   cd /home/eeimoo/actions-runner
   sudo ./svc.sh install
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

4. **验证 Runner 在线**
   - 回到 GitHub → Settings → Actions → Runners
   - 确认 `eeimoo-local-runner` 状态显示为 **🟢 Idle**

5. **删除不再需要的 GitHub Secrets**
   - GitHub → Settings → Secrets and variables → Actions
   - 删除以下 secrets：
     - `PROD_SSH_HOST`、`PROD_SSH_USER`、`PROD_SSH_KEY`
     - `STAGING_SSH_HOST`、`STAGING_SSH_USER`、`STAGING_SSH_KEY`、`STAGING_ENV_FILE`
     - 可选保留：`GHCR_USERNAME`、`GHCR_TOKEN`、`ACR_USERNAME`、`ACR_PASSWORD`（或也删除，如果已经在 runner .env 中配置完整）

### 推荐操作

6. **配置 production 环境审批**
   - GitHub → Settings → Environments → **production**
   - 确保 **Required Reviewers** 设置为老板您的账号（≥1 人）
   - Deployment branches: `main`（仅 main 分支可部署生产）

7. **测试 CI 触发**
   - `git push` 到 `main` 分支
   - 在 GitHub → Actions 标签页观察流水线执行
   - 确认 lint → test → build-and-push → deploy-staging → deploy-production 全部通过

8. **清理临时文件**
   ```bash
   rm /tmp/actions-runner.tar.gz
   ```

---

## 6. 注意事项

| 关注点 | 说明 |
|--------|------|
| **Runner 安全** | 自托管 runner 会在本机执行 CI 代码，**任何人都能通过 PR 触发代码在本机运行**。建议 PR 只触发 `lint` + `test`，不运行 `deploy` 等敏感 job。已在 ci.yml 中通过 `if:` 条件控制。 |
| **Docker socket** | Runner 需要访问 Docker socket（通过 snap 安装的 Docker 可能需要额外配置 `docker` 组权限） |
| **服务保活** | Runner 安装为 systemd 服务，系统重启后会自动启动 |
| **环境变量** | 如果后续需要新增环境变量，编辑 `/home/eeimoo/actions-runner/.env` 后重启服务：`sudo systemctl restart actions.runner.*` |
| **Runner 升级** | 定期检查新版本：`cd /home/eeimoo/actions-runner && ./config.sh --stop && sudo ./svc.sh stop && curl -LO ... && tar xzf ... && sudo ./svc.sh start` |
