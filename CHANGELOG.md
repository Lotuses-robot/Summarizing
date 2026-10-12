# 更新日志（CHANGELOG）

本项目的所有重要变更都记在这里。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)（`v主.次.修`）。
0.x 阶段：次版本号表示「阶段批次」的推进，修订号表示同批次的修复。**部署只跟 tag，不跟 main HEAD**（docs/11 阶段 2）。

发布流程见 `docs/12-版本与发布.md`。

## [未发布]

（下一版本开发中）

## [v0.2.0] - 2026-10-12

### 批次 2 · 代码侧上云项

- **Docker 化**：多阶段 `Dockerfile`（构建阶段出前端 + esbuild 服务端单文件；运行阶段只带精简 better-sqlite3）+ `docker-compose.yml`（app + Caddy；数据 bind mount 到宿主机 `./data`；应用端口不直暴公网；`APP_IMAGE` 双形态：本地 build 或拉 ACR 镜像）+ `Caddyfile`（TLS 自动证书、安全头、`/hook` 不记日志）。
- **schema 迁移**：`PRAGMA user_version` 版本门控 + 迁移前自动备份（保留最近 5 份）+ 逐库跑；迁移与版本写入同一事务；备份戳用北京墙钟（D-97）；备份失败即中止（含并发读者检测）。
- **备份 / 恢复**：`npm run admin -- backup|restore`（SQLite `.backup` API 在线热备、不停服；恢复覆盖 + 清 WAL 残留）。
- **时区定死北京时间 +08:00**（D-97）：服务端产时与前端显示全部固定 UTC+8，不依赖运行机器/浏览器时区。
- **CI**：`.github/workflows/check.yml`（push/PR 质量门）+ `release.yml`（tag → windows 出便携包挂 Release；构建并推阿里云 ACR 镜像）。
- **版本与部署规范**：`docs/12-版本与发布.md`（semver / 部署只跟 tag）+ `docs/13-部署运维.md`（初始化 / 升级 runbook / 回滚 / ACR 配置）。
- **运维脚本**：`scripts/upgrade.mjs`（在线备份 → 拉镜像 → 重启迁移 → 健康检查）、`scripts/server-init.sh`（服务器初始化一条龙）、`scripts/build-server.mjs`（打包配方单出处）。

## [v0.1.0]

首个可用版本：把散落的信息拼成完整图景。

### 核心
- 信息进站流水线：粘贴/信源 → 落盘 → AI 消化事项 → 看板。
- 多用户：单实例多账户，每账户一库（`data/users/<uid>.db`）；邀请制注册；会话登录。
- 信源适配器（nc 群聊）；信源网关 `/hook/<令牌>/<信源>/*`。
- 看板 / 流水 / 存疑库 / 对话 / 设置 五面。
- 便携包：免安装 Windows zip（`npm run build:release`）。
