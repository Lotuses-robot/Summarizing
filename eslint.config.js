import eslint from "@eslint/js";
import eslintPluginJsdoc from "eslint-plugin-jsdoc";
import importX from "eslint-plugin-import-x";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "data/**", "archive/**", "docs/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    plugins: {
      jsdoc: eslintPluginJsdoc,
    },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 忘 await = 静默失败（本项目最恨的失败形态）
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Fastify 处理器惯例一律 async，没 await 不是错
      "@typescript-eslint/require-await": "off",
      // 工程红线：禁 any
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // 非空断言绕过 undefined 检查，与 noUncheckedIndexedAccess 的意图冲突
      "@typescript-eslint/no-non-null-assertion": "error",
      // ⚠️ 最高优先级：严厉限制类型绕过（用户 2026-09-24）——「我比编译器懂」的断言是 bug 温床
      // no-unsafe-* 系列由 recommendedTypeChecked 已开启；此处再禁两种最危险的显式写法
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSUnknownKeyword",
          message: "禁止 as unknown as（双重断言绕过类型系统）；改用类型守卫/zod 解析/satisfies。",
        },
        {
          selector:
            "TSAsExpression[typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='Record']",
          message: "慎用 as Record<...>；优先用带名字的类型或 satisfies。",
        },
      ],
      eqeqeq: "error",
      // 服务端走 fastify 的 pino logger，前端不打印
      "no-console": "error",
      // 用户要求：每个独立函数首行前必须有 JSDoc 人话描述（拒绝幻觉、方便读结构）
      // 只匹配：function 声明、const x = () => …；不碰对象方法/回调/schema 常量
      "jsdoc/require-jsdoc": [
        "error",
        {
          contexts: [
            "FunctionDeclaration",
            "VariableDeclaration:has(VariableDeclarator > ArrowFunctionExpression)",
          ],
          exemptEmptyFunctions: false,
        },
      ],
      "jsdoc/require-description": "error",
      "jsdoc/check-param-names": "error",
      // 变更清单的动作白名单会增长（S2 加合并/correct）——
      // 加了新动作但哪个 switch 忘了处理，这里直接报错
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "import-x": importX },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      // 默认 node resolver 与 eslint 10 接口不兼容，换 TS resolver
      "import-x/resolver": { typescript: { alwaysTryTypes: true } },
    },
    rules: {
      // 模块循环依赖 = 架构腐化第一步（如 storage ↔ agent0 互引），早爆早好
      "import-x/no-cycle": ["error", { maxDepth: 4 }],
    },
  },
  {
    // 运维脚本（纯 node；命令行输出就是要给人看的，console 合法）
    files: ["scripts/**/*.{mjs,ts}"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
    rules: { "no-console": "off" },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  prettier,
);
