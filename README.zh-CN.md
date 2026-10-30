# OpenCode Go for SiYuan

[English](README.md) · **简体中文**

把 [OpenCode Go](https://opencode.ai/docs/go/) 订阅接入思源笔记自身 AI 设置页的插件。

![preview](https://gcore.jsdelivr.net/gh/wmy2981/opencode-go-siyuan@main/assets/preview.png)

## 功能

- 原生供应商，按需创建
- 逐会话的 `x-opencode-session`
- 完整的用量显示

## 环境要求

- 思源 **3.8.5** 及以上

## 使用

打开插件设置，按面板里的编号指引操作一遍——插件不会自行改动用户配置：

1. **创建 OpenCode Go 供应商。** 只有点击按钮才会创建；若「设置 - 人工智能」里已经有指向
   `https://opencode.ai/zen/go/v1` 的条目，插件会直接接管它，因此不会出现第二张卡片。
2. **填写凭据。** 点击按钮直接打开思源原生的「人工智能」设置页并定位到该供应商，在那里粘贴 API Key，
   并按思源原生的方式添加需要的模型（也可以回插件设置页点「添加所有可用模型」一次补齐）。
3. **检查。** 点击按钮检查供应商、请求头、API Key、会话变量与用量接口，结果显示在下面。

## 会话请求头是怎么实现的

内核会在**每个请求**上解析供应商请求头里的 `{{vars.NAME}}` 占位符，所以注入的供应商带的是：

```json
"headers": {
  "x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}",
  "User-Agent": "siyuan-opencode-go/1.0.0"
}
```

插件在 `/api/ai/agent/chat`（编辑器对话是 `/api/ai/editor/chat`）离开客户端之前，从请求体读出
`sessionID`（或 `taskID`），与变量不同就先写入变量再放行，因此首轮即正确、整段对话保持一致。

其它插件经 `/api/network/forwardProxy` 转发到同一端点的请求没有「对话」，插件会在它们发出前把变量
切回安装级 ID；这类插件需自带请求头 `{"x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}"}`，如
[ai-title-siyuan](https://github.com/wmy2981/ai-title-siyuan)。插件自己的 `/v1/usage` 查询不受此规则约束。

**已知限制：** 内核无法逐请求注入请求头，插件只能靠变量加一个范围极窄的 `window.fetch` 拦截；
`onunload` 会还原 `fetch`，写变量失败时按原值放行——变量缺失或陈旧时请求头仍非空，不会被 `400` 拒绝，
只损失部分缓存亲和性。关闭「按会话发送」后统一使用安装级 ID。

## 说明与限制

- **这不是 OpenCode 官方客户端。** 其 Go 文档写明该套餐面向 OpenCode 及产生同类请求的编码智能体，
  流量会被监测滥用，「已验证客户端」名单之外（含本插件）**明确不保证持续可用**；服务条款禁止用多账号
  绕过用量限制，违者可能被终止访问。设置面板在指引上方用红字重复了这一点：风险自负。
- 用量接口 `GET https://opencode.ai/zen/go/v1/usage` 是一方路由但**没有官方文档**，响应形态已改过一次：
  插件按防御式解析，缺字段一律当作「未知」而非 0，并丢弃窗口为 0% 时上游给的占位重置时间。它每个窗口
  只返回一个聚合百分比，而官方限额按模型计算，具体模型的数字可能与 console 页面不同。
- 该接口对 `OPTIONS` 预检回 `404` 且**不带任何 CORS 头**（`/v1/models` 带），渲染进程无法直连，所以
  查询交给内核转发，与对话请求同路；API Key 始终没有离开本机。
- 模型条目的上游模型名取自 `name` 字段（如 `deepseek-v4.1-flash`），详情窗口显示它而非思源内部的条目
  id，当前模型不属于本供应商时整行不显示。模型列表默认不动：只有点「添加所有可用模型」才拉一次清单，
  且只追加缺失条目，已有条目的显示名、上下文长度与启用状态一律保留；自检里的「模型」只是计数。
- API Key 必须是可打印 ASCII。空白、零宽字符与 BOM 会被自动清掉（它们正是网关回 *Invalid API key.*
  的原因），其它非 ASCII 字符只能重新粘贴一次，自检会指出是第几位。
- 思源自带的「测试连接」只要 `/v1/models` 有响应（该接口不需要 key），就会把它那次补全请求的任何失败
  显示成「该模型不在可用模型列表中」，所以缺 key 或被拒在那里看着像模型问题；真实原因请看用量弹窗底部
  的错误块、设置页自检与调试日志。
- 卡片图标由插件在原生列表渲染后贴上：思源的供应商图标只取自内置预设表（按 baseURL 匹配），没有给
  第三方品牌留接口，所以插件会替换每张指向官方端点的卡片头像；改名或跨设备同步后图标依然存在。
- `User-Agent` 通过供应商请求头注入；若未来内核覆盖了它，可切换策略，或直接在「设置 - 人工智能 -
  OpenCode Go - 请求头」里改写。
- 插件不会把 API Key 写进日志、提示或 DOM，用量请求只使用供应商配置里已存的 key。
  `OPENCODE_GO_SESSION` 由插件维护并在卸载时删除，手动删除只会损失缓存亲和性，不会导致请求被拒。

## 集市趋势图表

![集市趋势图表](https://siyuan-bazaar-stats-graph.sr1.cc.cd/api/chart/wmy2981/opencode-go-siyuan?metrics=downloads,rating,ratings&range=all&area=true&lang=zh)

## 开发

```bash
npm install
npm run dev        # 监听构建，产物落在仓库根目录
npm run typecheck  # tsc --noEmit
npm run build      # 生成 dist/ 与 package.zip
npm run icon       # assets/icon.svg  -> assets/icon.png（160x160，<= 64 KiB）
npm run preview    # assets/preview.html -> assets/preview.png（1024x768，<= 512 KiB）
```

`npm run preview` 通过 Playwright 驱动 Chromium；若浏览器缺失，先执行一次
`npx playwright install chromium`。

## 许可与赞助

基于 [MIT 许可证](LICENSE) 开源。如果这个插件有帮助，可以在
<https://afdian.com/a/wmy2981> 支持作者。
