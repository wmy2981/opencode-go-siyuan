# OpenCode Go for SiYuan

**English** · [简体中文](README.zh-CN.md)

A SiYuan plugin that brings the [OpenCode Go](https://opencode.ai/docs/go/) subscription into
SiYuan's own AI settings page.

![preview](https://gcore.jsdelivr.net/gh/wmy2981/opencode-go-siyuan@main/assets/preview.png)

## What it does

- **Native provider, created on request.** The plugin settings panel walks through three steps:
  *create the `OpenCode Go` provider* → *paste the key on SiYuan's own AI page* → *check*. Nothing in
  `Settings → AI` is touched before the matching button is clicked, and an entry that already
  points at the official endpoint is adopted instead of duplicated. Once created it is an ordinary
  provider — official icon, rename it, paste the key, add or remove models, disable or delete it right
  there in the native page. **Models are yours to add**; when you want the whole list at once, the
  settings page has *Add all available models*, which only appends the entries the provider is
  missing.
- **Per-conversation `x-opencode-session`.** OpenCode Go rejects requests without that header
  (`400 MissingSessionID`, checked before authentication) and asks for a stable id per conversation
  so that routing and prompt caching work. The kernel only supports static provider headers, so the
  plugin writes each conversation's own id into the `OPENCODE_GO_SESSION` variable *before* the
  request leaves the client.
- **Usage.** Rolling (5 hour), weekly and monthly percentages, shown either as the amount used or as
  the amount left — in the plugin settings panel and as a line under the agent input area. Click that
  line for a detail dialog with the three windows, their reset countdowns and the current endpoint;
  the upstream model name appears only while the current model belongs to this provider, and the
  session id only when the dialog was opened from that line. The same dialog opens from the optional
  top bar button, which is off by default. A failed query never blanks the UI: the last successful
  data stays on screen with a relative `last updated` (`just now`, `30s ago`, `5m ago`, `2h ago`), and
  the failure itself is still spelled out in the error box below that footer; the two do not conflict.
  When nothing has ever been fetched, the line under the input area shows as unavailable.

## Requirements

- SiYuan **3.8.5** or newer. Every API this plugin relies on was verified to exist at the `v3.8.5`
  tag: `Provider.Headers`, `ResolveAIProviderHeaders`, `/api/setting/setVariables`,
  `/api/setting/setAI`, `/api/network/forwardProxy`, `openSetting(app, tab)` from the plugin API,
  `window.siyuan.config.variables`.
- An OpenCode Go subscription and an API key from <https://opencode.ai/auth>.
- The usage query is relayed by the kernel (`/api/network/forwardProxy`, the same route the chat
  request uses), which needs the **administrator** role. The desktop and mobile apps always have it;
  a browser session logged in with a read-only access code does not — the query then fails, the dialog
  and the settings self check spell out why, and the UI never passes stale numbers off as current
  (the relative update time shows how old they are).

## Install

1. Download `package.zip` from the latest release.
2. Unzip it into `<workspace>/data/plugins/opencode-go-siyuan/` so that `plugin.json` sits directly
   inside that folder.
3. Enable the plugin in *Settings → Marketplace → Downloaded*.

## Setup

Open the plugin settings and follow the numbered guide — the plugin does nothing to the
configuration on its own:

1. **Create the OpenCode Go provider.** Press the button; if *Settings → AI* already holds an entry
   on `https://opencode.ai/zen/go/v1` it is adopted, so no second card is created.
2. **Fill in the credentials.** Press the button to open SiYuan's own AI settings page on that
   provider, paste the API key and add the models you need the native way (or press *Add all available
   models* in the plugin settings to fill in the whole list).
3. **Check.** Press the button to verify the provider, its headers, the key, the session variable and
   the usage endpoint; the result is printed right below. The check can be run repeatedly, and four of
   its rows are coloured by severity: missing headers, differing values, the key and the usage query
   show up green (fine), amber (warning) or red (broken).

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

Requests that other plugins relay to the same endpoint get the installation-level id instead. Such a
plugin does not go through `/api/ai/*/chat`: it builds its own headers and hands the call to
`/api/network/forwardProxy`, resolving `{{vars.OPENCODE_GO_SESSION}}` itself — that is the path
[ai-title-siyuan](https://github.com/wmy2981/ai-title-siyuan) takes to generate note titles. Those
requests have no conversation to belong to, so the plugin switches the variable back to the
installation-level id before they leave, and repeating the same call keeps hitting the same session.
Fill this into that plugin's **custom request headers**:

```json
{
  "x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}"
}
```

The plugin's own `/v1/usage` query is exempt from this rule: the value it sends is the one the
detail dialog shows.

**Known limitation:** SiYuan's kernel cannot inject a per-request header on its own. The plugin
therefore uses the variable channel plus a narrowly scoped `window.fetch` interception, restores
`fetch` on unload, and falls back to the old value if writing the variable fails — a missing or
stale variable still produces a non-empty header, so the request is never rejected with `400`, it
only loses some prompt-cache affinity. If you turn the per-conversation switch off, one
installation-level id is sent for everything.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| *guide: create / fill in / check* | — | The three buttons at the top; every change to SiYuan's configuration happens here and only after a click. |
| Add all available models | — | Fetches the list from `/v1/models` and adds the models the provider does not have yet; existing entries are neither duplicated nor renamed or re-measured. |
| Repair the provider config | — | Fill in missing required headers and endpoint fields, strip blanks and zero width characters out of the API key, and rebuild the provider if it was deleted (an existing entry on the same endpoint is adopted instead of duplicated). |
| Usage detail dialog | — | Opens the same dialog as clicking that line: the three windows, how long ago the last successful query ran, and the error detail when a query failed; the session id is only shown when the dialog is opened from that agent line. |
| Dynamic x-opencode-session header | on | *On* writes each conversation's own `x-opencode-session` before the request leaves; *off* sends the static session id below for everything. Requests other plugins relay to the same endpoint always use the static id. |
| Static session ID | empty | Used when the switch above is off, and by other plugins relaying requests to the same endpoint; an installation-level id is generated when left empty. |
| User-Agent policy | kernel | Keep SiYuan's own User-Agent, use the plugin identity, or type a custom one. |
| Custom User-Agent | empty | Only used with the custom policy. |
| Show usage in the agent panel | on | The `OpenCode Go · 5h n% · Week n%` line under the agent input area. |
| Windows shown below the agent input | 5 hours and week | Which windows that line shows: 5 hours and week / 5 hours, week and month / 5 hours and month / week and month / 5 hours only. The dialog is unaffected. |
| Usage display style | used | Whether the percentages in the dialog and on that line show the amount used or the amount left; the bar follows the same choice. |
| Top bar usage button | off | Registers a plugin button in the top bar that opens the usage dialog. |
| Usage refresh interval | 300 s | 30 – 3600 seconds. Opening the settings page or the detail dialog forces one refresh. |
| Debug log | off | Prefixed diagnostics in the developer console. Does not contain the API key. |

Below the third step the panel shows a read-only self check: whether a provider is present on the
official endpoint, which required headers are missing or differ, whether the key is set (and whether
it holds a non-ASCII character), how many models have been added, the current session id and the last
usage result. The same result is what the **Check** button refreshes.

Deleting the provider in *Settings → AI* is respected permanently: the plugin creates it only from
the **Create the OpenCode Go provider** button, so it does not reappear on its own, not even after
a restart.

## Notes and limitations

- **This is not an official OpenCode client.** OpenCode's Go documentation says the plan is meant
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
  leaves the machine.
- It returns one aggregate percentage per window. OpenCode documents the limits per model, so the
  numbers can differ from the console page for a specific model.
- Model entries use the bare model id (for example `deepseek-v4.1-flash`) as the upstream model name;
  the dialog shows that name rather than the internal id SiYuan assigns to the entry. The row is
  hidden altogether while the current model belongs to another provider.
- The model list stays untouched by default: only *Add all available models* fetches it once, and it
  merely appends the missing entries — display names, context lengths and enabled flags of existing
  entries are left alone. The self check only counts them.
- The API key must be printable ASCII. Whitespace, zero width characters and byte order marks are
  stripped automatically (they are what makes the gateway answer *Invalid API key.*), but any other
  non-ASCII character has to be fixed by pasting the key again; the settings self check points at the
  exact position.
- SiYuan's own **Test connection** button under *Settings → AI* shows *"the model is not in the
  available list"* for **any** failure of its one-token probe whenever `/v1/models` answered (that
  endpoint needs no key), so a rejected or missing key looks like a model problem there. The error box
  in the usage dialog, the self check and the debug log report what the endpoint actually said.
- The card icon is applied by the plugin after the native list renders: SiYuan only ever takes a
  provider icon from its own built-in preset table (matched by base URL) and exposes no hook for
  third-party brands, so the plugin swaps the avatar of every card that points at the official
  endpoint. This also means the icon survives a rename of the provider or a sync from another device.
- The `User-Agent` is injected through the provider's headers. If a future kernel release overwrites
  it, switch the policy or set the header manually in *Settings → AI → OpenCode Go → Headers*.
- The plugin does not write the API key to a log, a message or the DOM; it only uses the key stored in
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

Released under the [MIT License](LICENSE). If this plugin is useful, you can support the
author at <https://afdian.com/a/wmy2981>.
