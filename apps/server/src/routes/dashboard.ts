import type { FastifyInstance } from "fastify";
import type { RegistryDb } from "../storage/registry";
import { makeDashboardService } from "../application/dashboard";

// 公开状态面板（011）：`GET /api/dashboard`（白名单 JSON）+ `GET /dashboard`（自包含 HTML）。
// 注册在**公开面**——无认证、无 Cookie、无参数；数据面只在 application/dashboard.ts 里聚合。
// 页面自包含（inline CSS/JS，无外链、无 CDN），不进入 React 构建；30 秒轮询自身 API。

/** 页面（服务端直出）：状态卡 + 数字 + 排行；失败时只改状态行，不把旧数据冒充新数据。 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>运行状态 · Summarizing</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f5f6f8; --card: #ffffff; --ink: #1c2024; --muted: #6b7280;
  --line: #e4e7eb; --accent: #0f766e; --danger: #b91c1c; --warn: #b45309; --bar: #e7ebef;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1214; --card: #171b1f; --ink: #e6e8ea; --muted: #9aa3ad;
          --line: #2a3138; --accent: #2dd4bf; --danger: #f87171; --warn: #fbbf24; --bar: #2a3138; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
       font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 40px 20px 64px; }
.eyebrow { color: var(--accent); font-weight: 600; letter-spacing: .08em; font-size: 13px; text-transform: uppercase; }
h1 { margin: 6px 0 4px; font-size: clamp(28px, 5vw, 40px); line-height: 1.15; display: flex; align-items: center; gap: 12px; }
.dot { width: 12px; height: 12px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ok { background: var(--accent); box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 18%, transparent); }
.dot.bad { background: var(--danger); box-shadow: 0 0 0 6px color-mix(in srgb, var(--danger) 18%, transparent); }
.sub { margin: 0; color: var(--muted); }
.grid { display: grid; gap: 14px; margin-top: 22px; }
.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 760px) { .four, .two { grid-template-columns: 1fr; } }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; min-width: 0; }
.card h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .06em; color: var(--muted); text-transform: uppercase; }
.big { font-size: 30px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.small { margin: 6px 0 0; color: var(--muted); font-size: 12.5px; }
.rows { margin: 0; display: grid; gap: 7px; }
.rows div { display: flex; justify-content: space-between; gap: 12px; }
.rows dt { color: var(--muted); }
.rows dd { margin: 0; font-variant-numeric: tabular-nums; }
.rank { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.rankline { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
.rankval { color: var(--muted); font-variant-numeric: tabular-nums; }
.bar { margin-top: 5px; height: 6px; border-radius: 999px; background: var(--bar); overflow: hidden; }
.fill { height: 100%; width: 0; border-radius: 999px; background: var(--accent); transition: width .4s ease; }
.fill.low { background: var(--danger); }
.disk { margin-top: 14px; }
.diskline { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12.5px; }
footer { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 22px; color: var(--muted); font-size: 12.5px; }
.warn { color: var(--warn); }
</style>
</head>
<body>
<main>
  <header>
    <div class="eyebrow">Summarizing</div>
    <h1><span id="dot" class="dot"></span><span id="status">读取中…</span></h1>
    <p id="sub" class="sub">正在获取状态</p>
  </header>

  <section class="grid four">
    <article class="card"><h2>今日进站</h2><div id="rawToday" class="big">—</div><p id="rawSub" class="small">已消化 — · 失败 —</p></article>
    <article class="card"><h2>消化队列</h2><div id="queue" class="big">—</div><p id="queueSub" class="small">排队 — · 消化中 —</p></article>
    <article class="card"><h2>今日模型调用</h2><div id="calls" class="big">—</div><p class="small">按北京时间日历日</p></article>
    <article class="card"><h2>今日 token</h2><div id="tokenTodayTotal" class="big">—</div><p id="tokenTodaySub" class="small">未命中 — · 输出 — · 缓存 —</p></article>
  </section>

  <section class="grid two">
    <article class="card">
      <h2>内容</h2>
      <dl class="rows">
        <div><dt>事项</dt><dd id="tasks">—</dd></div>
        <div><dt>通知</dt><dd id="notices">—</dd></div>
        <div><dt>回收站</dt><dd id="trashed">—</dd></div>
      </dl>
    </article>
    <article class="card">
      <h2>累计 token</h2>
      <div id="tokenTotal" class="big">—</div>
      <p id="tokenTotalSub" class="small">未命中 — · 输出 — · 缓存 —</p>
    </article>
  </section>

  <section class="grid two">
    <article class="card">
      <h2>用量排行（累计 · 前 2）</h2>
      <ol id="ranking" class="rank"><li class="small">暂无数据</li></ol>
    </article>
    <article class="card">
      <h2>资源</h2>
      <dl class="rows">
        <div><dt>账户</dt><dd id="accounts">—</dd></div>
        <div><dt>图片</dt><dd id="media">—</dd></div>
        <div><dt>数据库</dt><dd id="databases">—</dd></div>
        <div><dt>内存</dt><dd id="memory">—</dd></div>
      </dl>
      <div class="disk">
        <div class="diskline"><span>数据盘</span><span id="diskText">—</span></div>
        <div class="bar"><div id="diskBar" class="fill"></div></div>
      </div>
    </article>
  </section>

  <footer>
    <span id="generated">数据时间 —</span>
    <span id="note"></span>
  </footer>
</main>
<script>
(function () {
  function byId(id) { return document.getElementById(id); }
  var lastOk = null;

  function fmt(n) { return typeof n === "number" ? n.toLocaleString("zh-CN") : "—"; }

  function fmtBytes(n) {
    if (typeof n !== "number") return "—";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v = v / 1024; i += 1; }
    return (i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)) + " " + units[i];
  }

  function fmtUptime(sec) {
    if (typeof sec !== "number") return "—";
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + " 天 " + h + " 小时";
    if (h > 0) return h + " 小时 " + m + " 分钟";
    return m + " 分钟";
  }

  function tokenParts(t) {
    return "未命中 " + fmt(t.inputTokens) + " · 输出 " + fmt(t.completionTokens) +
      " · 缓存 " + (t.cachedTokens === null ? "服务商未提供" : fmt(t.cachedTokens));
  }

  function tokenSum(t) {
    return t.inputTokens + t.completionTokens + (t.cachedTokens === null ? 0 : t.cachedTokens);
  }

  function rankItem(name, tokens, max) {
    var li = document.createElement("li");
    var line = document.createElement("div");
    line.className = "rankline";
    var nm = document.createElement("span");
    nm.textContent = name;
    var val = document.createElement("span");
    val.className = "rankval";
    val.textContent = fmt(tokens);
    line.appendChild(nm);
    line.appendChild(val);
    var bar = document.createElement("div");
    bar.className = "bar";
    var fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = (max > 0 ? Math.max(2, Math.round(tokens / max * 100)) : 0) + "%";
    bar.appendChild(fill);
    li.appendChild(line);
    li.appendChild(bar);
    return li;
  }

  function render(s) {
    lastOk = s.generatedAt;
    byId("dot").className = "dot ok";
    byId("status").textContent = "运行中 · v" + s.version;
    byId("sub").textContent = "已运行 " + fmtUptime(s.uptimeSec) + " · 开始于 " + s.startedAt;
    byId("rawToday").textContent = fmt(s.today.rawBatches);
    byId("rawSub").textContent = "已消化 " + fmt(s.today.digested) + " · 失败 " + fmt(s.today.digestFailed);
    byId("queue").textContent = fmt(s.queue.pending + s.queue.digesting);
    byId("queueSub").textContent = "排队 " + fmt(s.queue.pending) + " · 消化中 " + fmt(s.queue.digesting) +
      " · 未处理失败 " + fmt(s.failedRawInputs);
    byId("calls").textContent = fmt(s.today.llmCalls);
    byId("tokenTodayTotal").textContent = fmt(tokenSum(s.tokens.today));
    byId("tokenTodaySub").textContent = tokenParts(s.tokens.today);
    byId("tokenTotal").textContent = fmt(tokenSum(s.tokens.total));
    byId("tokenTotalSub").textContent = tokenParts(s.tokens.total);
    byId("tasks").textContent = fmt(s.items.tasks);
    byId("notices").textContent = fmt(s.items.notices);
    byId("trashed").textContent = fmt(s.items.trashed);
    byId("accounts").textContent = s.accounts.active + " / " + s.accounts.total + " 启用";
    byId("media").textContent = fmt(s.media.count) + " 张 · " + fmtBytes(s.media.bytes);
    byId("databases").textContent = s.databases.opened + " / " + s.databases.total + " 可读" +
      (s.databases.failed > 0 ? " · " + s.databases.failed + " 个不可读" : "");
    byId("memory").textContent = fmtBytes(s.memory.rssBytes);
    if (s.disk === null) {
      byId("diskText").textContent = "未知";
      byId("diskBar").style.width = "0%";
      byId("diskBar").className = "fill";
    } else {
      byId("diskText").textContent = fmtBytes(s.disk.freeBytes) + " 可用 / " + fmtBytes(s.disk.totalBytes);
      var pct = s.disk.totalBytes > 0 ? Math.round(s.disk.freeBytes / s.disk.totalBytes * 100) : 0;
      byId("diskBar").style.width = Math.max(0, Math.min(100, pct)) + "%";
      byId("diskBar").className = "fill" + (pct < 10 ? " low" : "");
    }
    var rank = byId("ranking");
    rank.textContent = "";
    if (s.tokenRanking.length === 0) {
      var empty = document.createElement("li");
      empty.className = "small";
      empty.textContent = "暂无数据";
      rank.appendChild(empty);
    } else {
      var max = s.tokenRanking[0].tokens;
      for (var i = 0; i < s.tokenRanking.length; i += 1) {
        rank.appendChild(rankItem(s.tokenRanking[i].name, s.tokenRanking[i].tokens, max));
      }
    }
    byId("generated").textContent = "数据时间 " + s.generatedAt + (s.cached ? "（缓存）" : "");
    byId("note").textContent = s.degraded ? "部分数据不可读" : "";
    byId("note").className = s.degraded ? "warn" : "";
  }

  function renderUnknown() {
    byId("dot").className = "dot bad";
    byId("status").textContent = "状态未知";
    if (lastOk !== null) {
      byId("sub").textContent = "上次成功获取：" + lastOk;
      byId("note").textContent = "下面的数字可能已过期";
      byId("note").className = "warn";
    } else {
      byId("sub").textContent = "从未成功获取过状态";
    }
  }

  function tick() {
    fetch("/api/dashboard", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(render)
      .catch(renderUnknown);
  }

  tick();
  setInterval(tick, 30000);
})();
</script>
</body>
</html>`;

/** 注册公开状态面板路由（公开面：无认证；`/dashboard` 在静态兜底之前注册，真实路由优先）。 */
export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: { registry: RegistryDb; dataRoot: string },
): void {
  const service = makeDashboardService(deps);

  app.get("/api/dashboard", async (req, reply) => {
    if (!service.allow(req.ip)) {
      return reply.code(429).send({ error: "请求过于频繁，请稍后再试" });
    }
    try {
      const snapshot = await service.snapshot();
      return reply
        .header("Cache-Control", "public, max-age=30")
        .header("X-Robots-Tag", "noindex")
        .send(snapshot);
    } catch {
      // 从未成功聚合：503（不泄露内部错误）
      return reply.code(503).header("X-Robots-Tag", "noindex").send({ error: "状态暂不可用" });
    }
  });

  app.get("/dashboard", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").header("X-Robots-Tag", "noindex").send(DASHBOARD_HTML),
  );
}
