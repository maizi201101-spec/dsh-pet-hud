# AGENTS.md — working on dsh-pet-hud

给后续接手这个仓库的 agent（或未来的你）。先读这一页，再动代码。

## 这是什么

DeepSeek Harness 的客户端插件：一个悬浮小宠物，显示账号余额与「自上次重置以来的消耗」，高峰时段余额圆点变红，有未读会话时切开心姿态。

## 目录

```
src/client.js        可编辑源码（视频以 __VIDEO_IDLE__ / __VIDEO_HAPPY__ 占位）
assets/*.webm        透明循环视频源（24fps，VP9+alpha）
scripts/build.mjs    把 assets 内联进 src，生成根目录的 client.js
client.js            构建产物，勿手改
index.js             宿主半边（空实现）
cordis.patch.yml     把插件插进 shell.overlay
test/smoke.mjs       冒烟测试（最小 React 替身，不依赖浏览器）
```

## 命令

```sh
npm run build   # src + assets → client.js
npm test        # 渲染冒烟：idle/happy 视频、未读、高峰标记
```

改动流程：改 `src/client.js` 或换 `assets/*.webm` → `npm run build` → `npm test` → 提交 `src` + `assets` + `client.js`。

## 架构要点

- 模块通过 `window.__ModuleLoader__.load({ id: 'dsh-pet-hud', factory })` 注册，`id` 必须与包名、`cordis.patch.yml` 里的 `name` 一致。
- 注册到 `shell.overlay`（根作用域），单独渲染，不动原生 UI。
- 余额：`ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })`，凭据由 DSH 管理，插件不接触。
- 会话状态：根 slot 会注入 `useSessionStatus`（`running` / `completionUnread`）与 `useSessions`（`byId[id].retainedBy.mainView`）。拿不到时要有退化为 idle 的路径。
- 未读语义：原生只标「非主视图」的完成；主视图的完成由插件自己的 `finished` 集合补，进入主视图或开始输入时清除。
- 高峰：北京时间工作日 9:00–12:00、14:00–18:00，法定节假日除外；节假日表 `CN_HOLIDAY_RANGES` 在 `src/client.js`，目前是 2026 年。
- 视频：两段循环，叠层按 mood 交叉淡入；只播放当前那段，窗口隐藏时暂停。

## 不变量

- 不收集、不上报任何数据；不要加 `fetch`/遥测/日志打印用户数据。
- 不要手改根目录 `client.js`；它是生成的。
- 改包名 / 模块 id 时，`package.json`、`cordis.patch.yml`、`window.__ModuleLoader__.load` 三处必须一起改。
- hook 必须无条件调用（React 规则）；fallback 用模块级空实现。
- 发版：改 `package.json` 版本 + `CHANGELOG.md`，`npm run build && npm test`，再提交、打 tag。

## 本地联调

profile 里 `dsh-pet-hud` 用 `link:` 指向本仓库，然后 `pnpm install`、重启 DSH。改完先 `npm run build`，再重启（没有 HMR 时）。

## 已知坑

- `client.js` 约 300KB，主要是内联视频；编辑器/工具读它很慢，改 `src/` 就好。
- 仓库已推送到 https://github.com/maizi201101-spec/dsh-pet-hud，默认分支 `main`。
- 素材是《起司猫》同人，不随 MIT 授权；公开发布前建议替换。
