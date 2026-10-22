import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff, LogOut, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { errText, type MeView } from "@summarizing/shared";
import { api } from "../api";
import { pushEscLayer } from "../lib/escLayer";
import { Card, Row, StatusSlot, useStatus } from "./settings/primitives";

// 用户卡（006）：账户事务的**独立落点**——不塞进设置弹层。
// 理由（用户 2026-10-03 批评）：设置 = 声明式偏好（固定控件 + 改完即生效、无保存按钮）；
// 改密/复制地址/轮换令牌是**动作型**事务（要按钮、要确认、要反馈）——不同物种，硬塞进设置会破设置词汇表。
// 与设置弹层同走「遮罩壳 + Esc 分层」，视觉节奏一致；入口在活动栏底部（设置图标上方）。

/** 带显示/隐藏的眼睛按钮的密码输入（GOV.UK password-input 惯例：默认隐藏、可 reveal——
 *  本地场景防手误；`spellcheck`/`autocapitalize` 关掉防 spell-jacking 与移动端首字母大写）。 */
function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  describedBy,
  invalid = false,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        className="input w-[16rem] max-w-full pr-9"
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-ink-muted hover:text-ink"
        aria-label={show ? "隐藏密码" : "显示密码"}
        aria-controls={id}
        onClick={() => setShow((s) => !s)}
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

/** 复制文本到剪贴板：成功一闪 / 失败可见提示（不静默）。 */
function useCopy(flash: (k: string, m: string) => void, sticky: (k: string, m: string) => void) {
  return (key: string, text: string) => {
    if (navigator.clipboard === undefined) {
      sticky(key, "剪贴板不可用——请手动选中复制");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => flash(key, "已复制"))
      .catch(() => sticky(key, "复制失败——请手动选中复制"));
  };
}

/** 用户弹层（独立于设置）：用户名 + 改密 + 接入地址/轮换 + 退出登录。 */
export function UserModal({
  open,
  onClose,
  me,
  onLogout,
  onTokenRotated,
}: {
  open: boolean;
  onClose: () => void;
  me: MeView;
  onLogout: () => void;
  onTokenRotated: (token: string) => void;
}) {
  const { statuses, flash, sticky } = useStatus();
  const copy = useCopy(flash, sticky);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Esc 分层退出（与设置弹层同款）：打开时把本层压栈；App 的全局 keydown 统一触发
  useEffect(() => {
    if (!open) return;
    return pushEscLayer(() => onCloseRef.current());
  }, [open]);

  // hooks 全部就位后才早退
  if (!open) return null;

  const mismatch = confirmPassword !== "" && newPassword !== confirmPassword;
  const canSubmit =
    oldPassword !== "" && newPassword.length >= 8 && newPassword === confirmPassword && !busy;

  /** 提交改密：成功清空三输入并提示（其余端已下线；本端 cookie 由服务端续签）。 */
  const submitPassword = () => {
    if (!canSubmit) return;
    setBusy(true);
    api
      .changePassword(oldPassword, newPassword)
      .then(() => {
        setOldPassword("");
        setNewPassword("");
        setConfirmPassword("");
        flash("pwd", "密码已修改（其他设备已下线）");
      })
      .catch((err: unknown) => sticky("pwd", `修改失败：${errText(err)}`))
      .finally(() => setBusy(false));
  };

  /** 轮换接入令牌（二次确认）：旧地址即刻失效——须同步更新 nc 配置。 */
  const rotate = () => {
    if (!window.confirm("重新生成接入令牌？现有接入地址会立即失效（nc 需改用新地址）。")) return;
    api
      .rotateSourceToken()
      .then(({ sourceToken: next }) => {
        onTokenRotated(next);
        flash("token", "已生成新令牌");
      })
      .catch((err: unknown) => sticky("token", `轮换失败：${errText(err)}`));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-[5dvh_0.75rem_0.75rem] sm:p-[10vh_1rem_1rem]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84dvh] w-[min(520px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <UserRound size={16} className="text-ink-muted" />
          <span className="font-semibold">账户</span>
          <span className="text-sm text-ink-muted">· {me.username}</span>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <Card icon={ShieldCheck} title="修改密码" desc="修改后其他设备自动下线">
            <Row label={<label htmlFor="pwd-old">原密码</label>}>
              <PasswordInput
                id="pwd-old"
                value={oldPassword}
                onChange={setOldPassword}
                autoComplete="current-password"
              />
            </Row>
            <Row label={<label htmlFor="pwd-new">新密码</label>} description="至少 8 个字符">
              <PasswordInput
                id="pwd-new"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                describedBy="pwd-error"
                invalid={mismatch}
              />
            </Row>
            <Row label={<label htmlFor="pwd-confirm">确认新密码</label>}>
              <PasswordInput
                id="pwd-confirm"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                describedBy="pwd-error"
                invalid={mismatch}
              />
            </Row>
            <Row label="确认修改">
              <button className="btn" disabled={!canSubmit} onClick={submitPassword}>
                {busy ? "修改中…" : "修改密码"}
              </button>
            </Row>
            <StatusSlot statuses={statuses}>
              {mismatch ? (
                <p id="pwd-error" role="alert" className="text-danger">
                  两次输入的新密码不一致
                </p>
              ) : undefined}
            </StatusSlot>
          </Card>

          <Card
            icon={RefreshCw}
            title="信源接入令牌"
            desc="所有信源共用；接入地址在「设置 → 信源」各源的卡片上"
          >
            <Row label="账户令牌" description="泄露就一键轮换（所有接入地址立即换新）" stacked>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 break-all rounded-md border border-line bg-canvas px-2 py-1 text-xs">
                  {me.sourceToken}
                </code>
                <button className="btn" onClick={() => copy("token", me.sourceToken)}>
                  <Copy size={13} /> 复制
                </button>
                <button className="btn" onClick={rotate}>
                  <RefreshCw size={13} /> 重新生成令牌
                </button>
              </div>
            </Row>
            <StatusSlot statuses={statuses.filter((s) => s.key === "token")} />
          </Card>

          <Card icon={LogOut} title="退出登录" desc="仅清除本设备会话">
            <Row label="退出当前账户" description="下次使用需重新登录">
              <button className="btn" onClick={onLogout}>
                <LogOut size={13} /> 退出登录
              </button>
            </Row>
          </Card>
        </div>

        <footer className="flex justify-end border-t border-line px-5 py-3">
          <button className="btn" onClick={onClose}>
            <Check size={14} /> 完成
          </button>
        </footer>
      </div>
    </div>
  );
}
