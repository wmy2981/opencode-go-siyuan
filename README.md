# OpenCode Go for SiYuan

**English** · [简体中文](README.zh-CN.md)

A SiYuan plugin that brings the [OpenCode Go](https://opencode.ai/docs/go/) subscription into
SiYuan's own AI settings page.

![preview](assets/preview.png)

## What it does

- **Native provider, created on request.** The plugin settings panel walks you through three steps:
  *create the `OpenCode Go` provider* → *paste the key on SiYuan's own AI page* → *check*. Nothing in
  `Settings → AI` is ever touched before you click the matching button, and an entry that already
  points at the official endpoint is adopted instead of duplicated. Once created it is an ordinary
  provider — official icon, rename it, paste the key, add or remove models, disable or delete it right
  there in the native page. **Models are yours to add**: the plugin never fetches or writes the model
  list.
- **Per-conversation `x-opencode-session`.** OpenCode Go rejects requests without that header
  (`400 MissingSessionID`, checked before authentication) and asks for a stable id per conversation
  so that routing and prompt caching work. The kernel only supports static provider headers, so the
  plugin writes each conversation's own id into the `OPENCODE_GO_SESSION` variable *before* the
  request leaves the client.
- **Usage.** Rolling (5 hour), weekly and monthly percentages — in the plugin settings panel and as
  a line under the agent input area. Click that line for a detail dialog with the three windows,
  their reset countdowns, the current endpoint / upstream model name / session and any error detail.

## Requirements

- SiYuan **3.8.5** or newer. Every API this plugin relies on was verified to exist at the `v3.8.5`
  tag: `Provider.Headers`, `ResolveAIProviderHeaders`, `/api/setting/setVariables`,
  `/api/setting/setAI`, `/api/network/forwardProxy`, `openSetting(app, tab)` from the plugin API,
  `window.siyuan.config.variables`.
- An OpenCode Go subscription and an API key from <https://opencode.ai/auth>.
- The usage query is relayed by the kernel (`/api/network/forwardProxy`, the same route the chat
  request uses), which needs the **administrator** role. The desktop and mobile apps always have it;
  a browser session logged in with a read-only access code does not — the usage line then reports the
  failure instead of showing numbers.

## Install

1. Download `package.zip` from the latest release.
2. Unzip it into `<workspace>/data/plugins/opencode-go-siyuan/` so that `plugin.json` sits directly
   inside that folder.
3. Enable the plugin in *Settings → Marketplace → Downloaded*.

## Setup

Open the plugin settings and follow the numbered guide — the plugin does nothing to your
configuration on its own:

1. **Create the OpenCode Go provider.** Press the button; if *Settings → AI* already holds an entry
   on `https://opencode.ai/zen/go/v1` it is adopted, so you never end up with two cards.
2. **Fill in the credentials.** Press the button to open SiYuan's own AI settings page on that
   provider, paste the API key and add the models you want the native way.
3. **Check.** Press the button to verify the provider, its headers, the key, the session variable and
   the usage endpoint; the result is printed right below. The check can be run as often as you like,
   and four of its rows are coloured by severity: missing headers, differing values, the key and the
   usage query show up green (fine), amber (warning) or red (broken).

## How the session header works

The kernel resolves `{{vars.NAME}}` placeholders inside a provider's request headers on **every
request**, so the injected provider carries:

```json
"headers": {
  "x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}",
  "User-Agent": "siyuan-opencode-go/1.0.0"
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
| *guide: create / fill in / check* | — | The three buttons at the top; every change to SiYuan's configuration happens here and only when you click. |
| Repair the provider config | — | Fill in missing required headers and endpoint fields, strip blanks and zero width characters out of the API key, and rebuild the provider if you deleted it (an existing entry on the same endpoint is adopted instead of duplicated). |
| Request header policy | on | *On* writes each conversation's own `x-opencode-session` before the request leaves; *off* sends the static session id below for everything. |
| Static session ID | empty | Used when the switch above is off; an installation-level id is generated when left empty. |
| User-Agent policy | kernel | Keep SiYuan's own User-Agent, use the plugin identity, or type a custom one. |
| Custom User-Agent | empty | Only used with the custom policy. |
| Show usage under the input | on | The `OpenCode Go · 5h n% · Week n%` line under the agent input area. |
| Usage detail dialog | — | Opens the same dialog as clicking that line: the three windows, the current session id and the endpoint error detail. |
| Usage refresh interval | 300 s | 30 – 3600 seconds. Opening the settings page or the detail dialog forces one refresh. |
| Debug log | off | Prefixed diagnostics in the developer console. Never contains the API key. |

Below the third step the panel shows a read-only self check: whether a provider is present on the
official endpoint, which required headers are missing or differ, whether the key is set (and whether
it holds a non-ASCII character), how many models you have added, the current session id and the last
usage result. The same result is what the **Check** button refreshes.

Deleting the provider in *Settings → AI* is respected permanently: the plugin only ever creates it
from the **Create the OpenCode Go provider** button, so it never reappears on its own, not even after
a restart.

## Notes and limitations

- **This is not an official OpenCode client.** OpenCode's own Go documentation says the plan is meant
  for OpenCode and for coding agents that produce similar traffic, that traffic is monitored for
  abuse, and it keeps a list of *validated clients* — anything else, including this plugin, is
  explicitly **not guaranteed to keep working**. Their terms of service also forbid using multiple
  accounts to circumvent usage limits and make a breach grounds for terminating access. The settings
  panel repeats this in red above the steps: use it at your own risk.
- The usage endpoint `GET https://opencode.ai/zen/go/v1/usage` is a first-party route of OpenCode
  itself, but it is **not documented** and its response shape already changed once. The plugin parses
  it defensively, treats missing fields as *unknown* instead of zero, and drops the placeholder reset
  time that the upstream reports while a window sits at 0%.
- That route answers an `OPTIONS` preflight with `404` and sends **no CORS headers** (unlike
  `/v1/models`), so the renderer cannot call it directly — a browser-side `fetch` with an
  `Authorization` header fails as `TypeError: Failed to fetch` before it is even sent. The plugin
  therefore relays the query through the kernel, exactly like the chat request. The key itself never
  leaves your machine.
- It returns one aggregate percentage per window. OpenCode documents the limits per model, so the
  numbers can differ from the console page for a specific model.
- Model entries use the bare model id (for example `deepseek-v4.1-flash`) as the upstream model name;
  the dialog shows that name rather than the internal id SiYuan assigns to the entry.
- The plugin never adds, fetches or edits models. Add them yourself on the provider page and the
  self check only counts them.
- The API key must be printable ASCII. Whitespace, zero width characters and byte order marks are
  stripped automatically (they are what makes the gateway answer *Invalid API key.*), but any other
  non-ASCII character has to be fixed by pasting the key again; the settings self check points at the
  exact position.
- SiYuan's own **Test connection** button under *Settings → AI* shows *"the model is not in the
  available list"* for **any** failure of its one-token probe whenever `/v1/models` answered (that
  endpoint needs no key), so a rejected or missing key looks like a model problem there. The usage
  line and the plugin's self check report what the endpoint actually said.
- The card icon is applied by the plugin after the native list renders: SiYuan only ever takes a
  provider icon from its own built-in preset table (matched by base URL) and exposes no hook for
  third-party brands, so the plugin swaps the avatar of every card that points at the official
  endpoint. That is also why it works after you rename the provider or sync it from another device.
- The `User-Agent` is injected through the provider's headers. If a future kernel release overwrites
  it, switch the policy or set the header manually in *Settings → AI → OpenCode Go → Headers*.
- The plugin never writes your API key to a log, a message or the DOM; it only uses the key stored in
  the provider for the usage request.
- `OPENCODE_GO_SESSION` lives in *Settings → Keys and variables*. The plugin maintains it and removes
  it when the plugin is uninstalled; deleting it manually only costs cache affinity, never a
  rejected request.

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

Released under the [MIT License](LICENSE). If this plugin is useful to you, you can support the
author at <https://afdian.com/a/wmy2981>.
