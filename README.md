# OpenCode Go for SiYuan

A SiYuan plugin that brings the [OpenCode Go](https://opencode.ai/docs/go/) subscription into
SiYuan's own AI settings page.

![preview](assets/preview.png)

## What it does

- **Native provider.** Adds an `OpenCode Go` provider to *Settings → AI*, pointing at the official
  `https://opencode.ai/zen/go/v1` Chat Completions endpoint with the official icon. It stays an
  ordinary provider: rename it, paste the key, add or remove models, disable or delete it right
  there in the native page.
- **Per-conversation `x-opencode-session`.** OpenCode Go rejects requests without that header
  (`400 MissingSessionID`, checked before authentication) and asks for a stable id per conversation
  so that routing and prompt caching work. The kernel only supports static provider headers, so the
  plugin writes each conversation's own id into the `OPENCODE_GO_SESSION` variable *before* the
  request leaves the client.
- **Usage.** Rolling (5 hour), weekly and monthly percentages — in the plugin settings panel and as
  a line under the agent input area. Click that line for a detail dialog with the three windows,
  their reset countdowns, the current endpoint/model/session and any error detail.

## Requirements

- SiYuan **3.8.5** or newer. Every API this plugin relies on was verified to exist at the `v3.8.5`
  tag: `Provider.Headers`, `ResolveAIProviderHeaders`, `/api/setting/setVariables`,
  `/api/ai/listModels`, `window.siyuan.config.variables`.
- An OpenCode Go subscription and an API key from <https://opencode.ai/auth>.

## Install

1. Download `package.zip` from the latest release.
2. Unzip it into `<workspace>/data/plugins/opencode-go-siyuan/` so that `plugin.json` sits directly
   inside that folder.
3. Enable the plugin in *Settings → Marketplace → Downloaded*.

## Setup

1. Enable the plugin. It creates the provider in *Settings → AI* automatically (this can be turned
   off in the plugin settings).
2. Open *Settings → AI → OpenCode Go* and paste your API key.
3. Pick a model in the agent model picker.

## How the session header works

The kernel resolves `{{vars.NAME}}` placeholders inside a provider's request headers on **every
request**, so the injected provider carries:

```json
"headers": {
  "x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}",
  "User-Agent": "siyuan-opencode-go/0.1.0"
}
```

Before a request to `/api/ai/agent/chat` (or `/api/ai/editor/chat`) is sent, the plugin reads the
`sessionID` (respectively `taskID`) from the request body, writes it into the variable if it
changed, and only then lets the request through. The value is therefore correct from the first turn
and stays stable for the rest of the conversation.

**Known limitation:** SiYuan's kernel cannot inject a per-request header on its own. The plugin
therefore uses the variable channel plus a narrowly scoped `window.fetch` interception, restores
`fetch` on unload, and falls back to the old value if writing the variable fails — a missing or
stale variable still produces a non-empty header, so the request is never rejected with `400`, it
only loses some prompt-cache affinity. If you turn the per-conversation switch off, one
installation-level id is sent for everything.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Inject the OpenCode Go provider | on | Create and maintain the provider in the native AI settings page. |
| Repair the provider config | — | Fill in missing required headers and endpoint fields. Existing values are never overwritten silently. |
| Refresh the model list | — | Re-fetch the provider's models through SiYuan's native model list API. |
| Send `x-opencode-session` per conversation | on | Write each conversation's own id before the request leaves. |
| Static session ID | empty | Used when the switch above is off; an installation-level id is generated when left empty. |
| User-Agent policy | kernel | Keep SiYuan's own User-Agent, use the plugin identity, or type a custom one. |
| Custom User-Agent | empty | Only used with the custom policy. |
| Show usage under the input | on | The `OpenCode Go · 5h n% · Week n%` line under the agent input area. |
| Usage refresh interval | 300 s | 30 – 3600 seconds. Opening the settings page or the detail dialog forces one refresh. |
| Refresh usage now | — | Query the usage endpoint immediately. |
| Debug log | off | Prefixed diagnostics in the developer console. Never contains the API key. |

The panel also shows a read-only self check: whether a provider hits the official endpoint, which
required headers are missing or differ, whether the key is set, how many models exist, the current
session id and the last usage result.

## Notes and limitations

- The usage endpoint `GET https://opencode.ai/zen/go/v1/usage` is a first-party route of OpenCode
  itself, but it is **not documented** and its response shape already changed once. The plugin parses
  it defensively, treats missing fields as *unknown* instead of zero, and drops the placeholder reset
  time that the upstream reports while a window sits at 0%.
- It returns one aggregate percentage per window. OpenCode documents the limits per model, so the
  numbers can differ from the console page for a specific model.
- Model entries use the bare model id (for example `deepseek-v4.1-flash`) as the upstream model name.
- The `User-Agent` is injected through the provider's headers. If a future kernel release overwrites
  it, switch the policy or set the header manually in *Settings → AI → OpenCode Go → Headers*.
- The plugin never writes your API key to a log, a message or the DOM; it only uses the key stored in
  the provider for the usage request.
- `OPENCODE_GO_SESSION` lives in *Settings → Keys and variables*. The plugin maintains it and removes
  it when the plugin is uninstalled; deleting it manually only costs cache affinity, never a
  rejected request.
- Not submitted to the SiYuan marketplace yet.

## Development

```bash
npm install
npm run dev        # watch build into the repository root
npm run typecheck  # tsc --noEmit
npm run build      # dist/ plus package.zip
npm run icon       # assets/icon.svg  -> assets/icon.png (160x160, <= 64 KiB)
npm run preview    # assets/preview.html -> assets/preview.png (1024x768, <= 512 KiB)
```

`npm run preview` drives Chromium through Playwright; run `npx playwright install chromium` once if
the browser is missing.

## License and funding

MIT. If this plugin is useful to you, you can support the author at
<https://afdian.com/a/wmy2981>.
