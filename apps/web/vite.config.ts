import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // /hook 也代理：设置页的接入地址随页面源拼装（dev 下复制出的 URL 直接可用）
    // /dashboard 是服务端直出的公开状态页（011）——dev 下与生产同形，同样转给 3001
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/hook": "http://127.0.0.1:3001",
      "/dashboard": "http://127.0.0.1:3001",
    },
  },
});
