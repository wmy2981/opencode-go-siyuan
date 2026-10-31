# OpenCode Go for SiYuan

**English** · [简体中文](README.zh-CN.md)

A SiYuan plugin that brings the [OpenCode Go](https://opencode.ai/docs/go/) subscription into
SiYuan's own AI settings page.

![preview](https://gcore.jsdelivr.net/gh/wmy2981/opencode-go-siyuan@main/assets/preview.png)

## What it does

- Native provider, created on request
- Per-conversation `x-opencode-session`
- Full usage display

## Requirements

- SiYuan **3.8.5** or newer.

## Usage

Open the plugin settings and follow the numbered guide — the plugin does nothing to the
configuration on its own:

1. **Create the OpenCode Go provider.** Press the button; if *Settings → AI* already holds an entry
   on `https://opencode.ai/zen/go/v1` it is adopted, so no second card is created.
2. **Fill in the credentials.** Press the button to open SiYuan's own AI settings page on that
   provider, paste the API key and add the models you need the native way (or press *Add all available
   models* in the plugin settings to fill in the whole list).
3. **Check.** Press the button to verify the provider, its headers, the key, the session variable and
   the usage endpoint; the result is printed right below.

## How the session header works

The kernel resolves `{{vars.NAME}}` placeholders inside a provider's request headers on **every
request**, so the injected provider carries:

```json
"headers": {
  "x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}",
  "User-Agent": "siyuan-opencode-go/1.0.0"
}
```

Before a request to `/api/ai/agent/chat` (or `/api/ai/editor/chat`) leaves the client, the plugin
reads `sessionID` (or `taskID`) from the body and writes it into the variable when it changed, so the
value is correct from the first turn and stays stable for the rest of the conversation.

Requests that other plugins relay to the same endpoint through `/api/network/forwardProxy` have no
conversation to belong to, so the plugin switches the variable back to the installation-level id
before they leave; such a plugin has to carry the header itself —
`{"x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}"}` — as
[ai-title-siyuan](https://github.com/wmy2981/ai-title-siyuan) does. The plugin's own `/v1/usage`
query is exempt.

**Known limitation:** the kernel cannot inject a per-request header, so the plugin uses the variable
plus a narrowly scoped `window.fetch` interception; `fetch` is restored on unload and a failed write
falls back to the old value — a missing or stale variable still yields a non-empty header, so nothing
is rejected with `400`, only some prompt-cache affinity is lost. With the per-conversation switch off,
one installation-level id is sent for everything.

## Notes and limitations

- **This is not an official OpenCode client.** Its Go documentation says the plan is meant for
  OpenCode and for coding agents that produce similar traffic, that traffic is monitored for abuse,
  and that anything outside its *validated clients* list — this plugin included — is **explicitly not
  guaranteed to keep working**; the terms of service forbid using multiple accounts to circumvent
  usage limits and make a breach grounds for terminating access. The settings panel repeats this in
  red above the steps: use it at your own risk.
- The usage endpoint `GET https://opencode.ai/zen/go/v1/usage` is a first-party route but **not
  documented**, and its response shape already changed once: the plugin parses it defensively, treats
  missing fields as *unknown* instead of zero, and drops the placeholder reset time reported while a
  window sits at 0%. It returns one aggregate percentage per window whereas the documented limits are
  per model, so a specific model can differ from the console page.
- That route answers an `OPTIONS` preflight with `404` and sends **no CORS headers** (unlike
  `/v1/models`), so the renderer cannot call it and the query goes through the kernel, like the chat
  request; the key itself never leaves the machine.
- Model entries take their upstream name from the `name` field (for example `deepseek-v4.1-flash`),
  which is what the dialog shows instead of SiYuan's internal entry id, and the row is hidden while
  the current model belongs to another provider. The list stays untouched by default: only *Add all
  available models* fetches it, and it merely appends the missing entries — display names, context
  lengths and enabled flags of existing entries are kept. The self check only counts them.
- The API key must be printable ASCII. Whitespace, zero width characters and byte order marks are
  stripped automatically (they are what makes the gateway answer *Invalid API key.*); any other
  non-ASCII character has to be fixed by pasting the key again, and the self check points at the exact
  position.
- SiYuan's own **Test connection** button shows *"the model is not in the available list"* for **any**
  failure of its probe whenever `/v1/models` answered (that endpoint needs no key), so a missing or
  rejected key looks like a model problem there; the error box in the usage dialog, the self check and
  the debug log report what the endpoint actually said.
- The card icon is applied by the plugin after the native list renders: SiYuan only takes a provider
  icon from its own built-in preset table (matched by base URL) and exposes no hook for third-party
  brands, so the plugin swaps the avatar of every card pointing at the official endpoint — the icon
  therefore survives a rename or a sync from another device.
- The `User-Agent` is injected through the provider's headers; if a future kernel release overwrites
  it, switch the policy or set the header manually in *Settings → AI → OpenCode Go → Headers*.
- The plugin never writes the API key to a log, a message or the DOM, and the usage request only uses
  the key stored in the provider. `OPENCODE_GO_SESSION` is maintained by the plugin and removed on
  uninstall; deleting it manually only costs cache affinity, never a rejected request.

## Bazaar Stats Graph

![Bazaar stats graph](https://siyuan-bazaar-stats-graph.sr1.cc.cd/api/chart/wmy2981/opencode-go-siyuan?metrics=downloads,rating,ratings&range=all&area=true&lang=en)

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

Released under the [MIT License](LICENSE). If this plugin is useful, you can support the
author at <https://afdian.com/a/wmy2981>.
