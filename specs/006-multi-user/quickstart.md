# Quickstart 验证剧本（多用户）

> 每一场景都可直接跑。断言用户所见（宪法 V）。SC 对应见括号。

**前置**：Node 22+；仓库根 `npm install` 已跑。

## S1 本机全流程（开发形态）

```bash
npm run db:reset                      # 清 system.db + users/（新语义）
npm run admin -- user:add alice       # 建首个账户（交互输密码）
npm run admin -- invite:new           # 记下 code（或设 BASE_URL 拿链接）
npm run dev                           # server :3001 / web :5173
```

1. http://localhost:5173 → 未登录只见登录/注册页；`curl -i localhost:3001/api/board` → **401**（SC-002）
2. 登录 alice → 正常主界面（单机等效行为，FR-007）
3. 无痕窗口打开 `/register?code=<code>` → 注册 bob → 进入自己的空空间；**该码再用即失败**（SC-003）
4. alice 录一件事项 + 对话一轮；bob 界面全程看不到 alice 任何一条，反之亦然（SC-001）
5. bob 登录页故意错密码 5 次 → 第 6 次起 **429 锁定**；等 15 分钟或重启服务解锁（SC-004）

## S2 信源 token 与网关

1. bob 登录 → 设置 → 账户组 → 复制接入地址 `/hook/<bob-token>/nc/event`
2. 用 nc 样例事件投递（白名单群一条消息）：

```bash
curl -i -X POST http://localhost:3001/hook/<bob-token>/nc/event \
  -H 'content-type: application/json' -d @nc-sample.json      # → 204
```

3. 等封批窗（默认 ≥1 分钟静默）→ bob 的流水出现该批次，alice 全链路无痕（SC-001 信源面）
4. 错 token：`/hook/deadbeef/nc/event` → **401**，且库里无任何写入
5. 设置 → 信源区「接入地址」框 → 点「重新生成接入令牌」（二次确认）→ 旧地址再来 → **401**；新地址投递 → 204

## S3 运维闭环（SC-003）

```bash
npm run admin -- user:list                    # alice/bob 在列
npm run admin -- user:disable bob
```

- bob 已登录会话下一操作 → 被送回登录页；登录被拒「账户已停用」；bob 的 webhook token → 401
- `npm run admin -- user:enable bob` → 恢复；`passwd:reset bob` → bob 旧会话全下线，新密码可登录

## S4 自动化与质量门（SC-005/006）

```bash
npm run check            # tsc + eslint + vitest（含 auth/isolation/网关新套件）
npm run check:dead       # knip
npm run build -w @summarizing/web
```

## S5 发布包（批次收尾时）

```bash
npm run build:release    # 含 admin.mjs 第二入口与 start.cmd 首启引导
```

- 解压 zip → `start.cmd` 首启 → 引导创建首个账户 → 浏览器注册/登录 → nc 用新 URL 格式接入

## 附：手动导入旧单机数据（D5：无收编机制，运维手动）

```bash
npm run stop                                  # 先停服（防服务器句柄指向旧文件）
npm run admin -- user:add alice               # 建账户；user:list 看 uid
cp data/summarizing.db data/users/<uid>.db    # 旧库顶替该账户的空库（首次打开跑幂等 ensureSchema 接管）
npm run dev                                   # 启服 → 登录 → 数据全在
```

⚠️ `data/system.db` 是账户索引——它丢了，所有用户库就成孤岛（不可寻址）。备份 = 整个 `data/`（docs/11 已写）。

**全部通过 = spec SC-001…SC-006 达成**（SC-006 另含 S 审查）。
