# ysk-language-contract 进度

## 2026-10-14 契约落入 detect/explain 与 Unicode 去重

### 当前阶段
implementing

### 本段结论
`language` 校验 fail-fast；配置后 detect/explain 写入 schema 硬约束，未配置写入跟随对话指令。CJK 有无检测 + 独立小请求修复一次，仍违约记 `language_rejected` 丢单。`norm()` 改 NFKC + Unicode 字母数字，空身份跳过去重。

### 关键决策与已否决方案
修复记在该次 check 的 `repair` 字段（usage/ms），不用独立 event。检测函数留在 index.ts 顶层。卡面未列的 `plain-English` / `Plain English` 一并中立化。

### 下一步唯一动作
补 E2E/单元锁（修复成功、丢单、混排、去重、非法 language）并写入 README。

## 2026-10-14 E2E 锁与 README

### 当前阶段
implementing

### 本段结论
`tests/language.test.mjs` 锁修复成功/丢单/混排/去重/非法 language/en 双向；`tests/routing.test.mjs` 断言真实 sidePayload 含跟随对话指令。README 在 Side models 后增加 Note language 小节。

### 关键决策与已否决方案
E2E 放新文件而非塞进 detection.test.mjs，避免把 idle-delivery 夹具和语言契约缠在一起。wire 负验注释掉 `{{LANGUAGE_CONTRACT}}` 注入后 routing/language 均 AssertionError 变红。

### 下一步唯一动作
提交本段、push，开 PR。
