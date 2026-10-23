import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { RouterAccountView, RouterChannel } from "@summarizing/shared";
import { errText } from "@summarizing/shared";
import { api } from "../../api";
import { cn } from "../../lib/cn";
import { fmtAgo } from "../../lib/time";
import { Card, Row, StatusSlot, useStatus } from "./primitives";

// 路由（D-130）账户侧：**只有两件事**——收不收、我的绑定码是什么。
//
// 凭据（corpId / secret / Token / AESKey）不在这里：它们属于部署方，走运维命令
// （`npm run admin -- router:set …`）。账户主人不需要知道微信另一端长什么样。
//
// 交互与整页一致：开关点了即存、码失焦/增删即存；成功一闪、失败常驻红字。

/** 绑定码编辑器（键值式行编辑的简化版：只有一列码）。
 *
 *  为什么是「行 + 添加一行」而不是一个大文本框：一行一个码，删除目标明确
 *  （一个框里换行分隔时，删错了整段都乱）。 */
function BindingsEditor({
  codes,
  onChange,
  onCommit,
}: {
  codes: string[];
  onChange: (next: string[]) => void;
  onCommit: (next: string[]) => void;
}) {
  return (
    <div className="w-full overflow-hidden rounded-lg border border-line">
      {codes.map((code, i) => (
        <div key={i} className="flex items-stretch border-t border-line first:border-t-0">
          <input
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-ink-muted"
            value={code}
            placeholder="粘贴客户给你的绑定码"
            onChange={(e) => onChange(codes.map((c, j) => (j === i ? e.target.value : c)))}
            onBlur={() => onCommit(codes)}
          />
          <button
            className="mr-1.5 inline-flex h-[1.5rem] w-[1.5rem] shrink-0 cursor-pointer items-center justify-center self-center rounded-lg text-ink-muted opacity-0 transition hover:bg-danger-soft hover:text-danger focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            title="删这一条"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const next = codes.filter((_, j) => j !== i);
              onChange(next);
              onCommit(next);
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {/* 幽灵行：与列表一体、无边框（同信源的键值编辑器） */}
      <button
        className="flex w-full cursor-pointer items-center gap-1.5 border-t border-line px-3 py-2 text-xs text-ink-muted transition-colors first:border-t-0 hover:bg-canvas hover:text-accent"
        onClick={() => onChange([...codes, ""])}
      >
        <Plus size={12} /> 添加绑定码
      </button>
    </div>
  );
}

/** 一个接入的分组卡：开关 + 绑定码。
 *
 *  标题与说明**来自接入自己的声明**（`label` / `description`）——前端不认识任何具体接入。
 *  加一个「校内新闻」接入时，这一页会自动多出一张卡，本文件一行不用改。 */
function ChannelCard({ channel }: { channel: RouterChannel }) {
  const [codes, setCodes] = useState<string[]>(channel.bindings);
  const [enabled, setEnabled] = useState(channel.enabled);
  const { statuses, flash, sticky } = useStatus();

  /** 提交整段码表：空行去掉再交（后端只认非空码）。 */
  const commitBindings = (next: string[]): void => {
    const cleaned = next.map((c) => c.trim()).filter((c) => c !== "");
    api
      .saveRouterBindings(channel.kind, cleaned)
      .then(() => {
        flash("bindings", "已保存");
        setCodes(cleaned);
      })
      .catch((err: unknown) => sticky("bindings", `保存失败：${errText(err)}`));
  };

  /** 开/关这一种接入：点了即存，失败把开关拨回去（不留一个说谎的控件）。 */
  const commitEnabled = (next: boolean): void => {
    setEnabled(next);
    api
      .setRouterEnabled(channel.kind, next)
      .then(() => flash("enabled", "已保存"))
      .catch((err: unknown) => {
        setEnabled(!next);
        sticky("enabled", `保存失败：${errText(err)}`);
      });
  };

  return (
    <Card
      // 与信源卡同款：卡头「名字 + 状态 chip」，副标题出错时显示原因
      title={
        <span className="flex flex-wrap items-center gap-2">
          {channel.label}
          {channel.state === "error" ? (
            <span className="chip shrink-0 border-danger/50 text-danger">最近出错</span>
          ) : (
            <span className={cn("chip shrink-0", !enabled && "text-ink-muted")}>
              {enabled ? "接收中" : "已关闭"}
            </span>
          )}
        </span>
      }
      desc={
        // 出错时副标题让位给「什么错、多久以前」——与信源卡同一口径
        channel.state === "error"
          ? `${channel.lastError ?? "未知错误"}${
              channel.lastErrorAt === undefined
                ? ""
                : `（${fmtAgo(channel.lastErrorAt) ?? channel.lastErrorAt}）`
            }`
          : channel.description
      }
    >
      <Row label="接收消息" description="关掉后这一种消息不进来，对方会收到「暂不可用」">
        <input
          type="checkbox"
          className="h-[1rem] w-[1rem] accent-accent"
          checked={enabled}
          onChange={(e) => commitEnabled(e.target.checked)}
        />
      </Row>
      <Row label="绑定码" description="一行一个——同一个来源可以有多个" stacked>
        <BindingsEditor codes={codes} onChange={setCodes} onCommit={commitBindings} />
      </Row>
      <StatusSlot statuses={statuses} />
    </Card>
  );
}

/** 路由区（账户侧）：**每个接入一张卡**。
 *
 *  读 `GET /api/router`（`channels[]`，每个接入自带 label/description/开关/绑定码）。
 *  未配置凭据时这一区照样显示——开关和码都不是凭据，账户主人随时可以填。
 *
 *  `id` = 锚点 id（左导航滚动定位用，由 SettingsModal 的 SECTION_DOM 单一出处传入）。 */
export function RouterSection() {
  const [view, setView] = useState<RouterAccountView | null>(null);
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    api
      .router()
      .then(setView)
      .catch(() => setReadFailed(true));
  }, []);

  // 只渲染**子项**（每个接入一张卡）——外层标题由 SettingsModal 的 <Card title="路由"> 给，
  // 与「信源」区同一个结构：父级是区，子级是具体来源。
  if (readFailed) {
    return <p className="px-0.5 text-sm text-danger">读取路由设置失败（后端是否在跑？）</p>;
  }
  if (view === null) return <p className="px-0.5 text-sm text-ink-muted">读取中…</p>;
  if (view.channels.length === 0) {
    return (
      <p className="px-0.5 text-sm text-ink-muted">还没有可用的路由（运维尚未启用任何接入）</p>
    );
  }
  return (
    <div className="space-y-5">
      {view.channels.map((ch) => (
        <ChannelCard key={ch.kind} channel={ch} />
      ))}
    </div>
  );
}
