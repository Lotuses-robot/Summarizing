import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initAppearance } from "./lib/appearance";
import "./index.css";

// 启动即应用外观偏好（主题/色板/字体/密度），并挂「系统」档跟随
initAppearance();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
