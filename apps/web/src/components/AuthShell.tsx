import { useState, type FormEvent } from "react";
import { errText, type MeView } from "@summarizing/shared";
import { api } from "../api";

/** 未登录壳（006）：登录/注册两视图互斥；页脚挂**备案号**——合规要求的公开可达页面即此壳。
 *  `?code=` 预填邀请码（运维把注册链接直接发给朋友）；注册成功即登录（onAuthed 交回 me）。
 *  `notice`：启动探测的后端不可达提示（评审修复——网络故障与「未登录」不再一并吞掉）。 */
export function AuthShell({
  onAuthed,
  notice = null,
}: {
  onAuthed: (me: MeView) => void;
  notice?: string | null;
}) {
  const prefillCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [mode, setMode] = useState<"login" | "register">(prefillCode === "" ? "login" : "register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState(prefillCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 提交当前视图；成功即拉 me 交回（注册与登录同一条收尾）。 */
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const run =
      mode === "register"
        ? api.register({ code, username, password })
        : api.login({ username, password });
    run
      .then(() => api.me())
      .then(onAuthed)
      .catch((err: unknown) => setError(errText(err)))
      .finally(() => setBusy(false));
  };

  /** 切换登录/注册视图（清掉上一视图的错误）。 */
  const toggle = () => {
    setMode((m) => (m === "login" ? "register" : "login"));
    setError(null);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      {notice !== null && (
        <p className="w-full max-w-sm rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
          {notice}
        </p>
      )}
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-surface p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold">{mode === "login" ? "登录" : "注册"}</h1>
        {mode === "register" && (
          <label className="block text-sm text-ink-muted">
            邀请码
            <input
              className="input mt-1 w-full"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
        )}
        <label className="block text-sm text-ink-muted">
          用户名
          <input
            className="input mt-1 w-full"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="block text-sm text-ink-muted">
          密码
          <input
            type="password"
            className="input mt-1 w-full"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
        </label>
        {error !== null && <p className="text-sm text-danger">{error}</p>}
        <button type="submit" className="btn w-full justify-center" disabled={busy}>
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册"}
        </button>
        <button
          type="button"
          className="w-full cursor-pointer text-center text-xs text-ink-muted hover:text-ink"
          onClick={toggle}
        >
          {mode === "login" ? "有邀请码？去注册" : "已有账户？去登录"}
        </button>
      </form>
      {/* 备案号：必须挂在公开可达页面（未登录壳即唯一公开面）——工信部链接随规 */}
      <footer className="text-center text-xs text-ink-muted">
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noreferrer"
          className="hover:text-ink"
        >
          粤ICP备2026147541号-1
        </a>
      </footer>
    </div>
  );
}
