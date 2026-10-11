# 运维命令契约（admin CLI）

> 唯一管理通道（FR-010）。站内零管理面；凭服务器/本机访问权使用。

**入口**（同一份代码，三形态）：

| 场景 | 调用 |
|---|---|
| 开发机 | `npm run admin -- <cmd>`（tsx） |
| 服务器（Docker） | `docker compose exec app node apps/server/dist/admin.mjs <cmd>` |
| Windows 便携包 | start.cmd 首启引导 / `node apps\server\dist\admin.mjs <cmd>` |

**通用约定**：

- 直接打开系统库 `data/system.db`（WAL，跨进程安全）——**与服务器进程运行与否无关**。
- 密码输入隐藏回显；空/过短（<8）拒收重问。
- 输出人话 + 退出码（0 成功 / 1 失败并说明原因）。操作留痕：stdout（服务器场景进 `docker logs`/shell 历史）。
- 管理通道不依赖任何账户状态——永不锁死（US3 验收 3）。

## 命令表

| 命令 | 语义 | 输出 |
|---|---|---|
| `user:add <username>` | 创建账户（交互输入密码）——**首个账户**即由它诞生；同时创建其空用户库与空间不依赖服务器进程（库在首次访问时自建） | `账户 <username> 已创建` |
| `user:list` | 全部账户 | 表格：username / status / created_at / **uid**（uid 供手动数据操作与排障——库文件名即它；不显示接入令牌） |
| `user:disable <username>` | 停用（下一请求即生效：登录拒、会话 401、webhook token 401） | 确认行 |
| `user:enable <username>` | 启用 | 确认行 |
| `passwd:reset <username>` | 重置密码（交互输入）；`token_version` +1 → 该账户全部旧会话下线 | 确认行 |
| `invite:new [--days N]` | 生成一次性邀请码（默认 7 天） | `code`；若设 env `BASE_URL` 则同时打印完整注册链接 `<BASE_URL>/register?code=<code>` |
| `invite:revoke <code>` | 作废未使用的邀请码 | 确认行 |

## 与服务器并发

- 停用/启用/重置在**运行中的服务器**上即时生效——服务器每请求读系统库校验（R1/R3），无缓存粘滞。
- `user:add` 后新用户即可登录（服务器在注册/登录路径按需装配其空间，R4）。
