# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run typecheck` — the only static check. There is no linter, formatter or test framework in this repo; do not add one unasked.
- `npm run build` — production bundle into `dist/`, then `package.zip` (flat, no `dist/` prefix, because the marketplace reads files from the archive root).
- `npm run dev` — watch build. It writes `index.js`, `index.css` and `i18n/` into the **repository root**, not `dist/` (all three are gitignored). A dev build is not what gets loaded into SiYuan.
- `npm run icon` / `npm run preview` — regenerate `assets/icon.png` (160x160) and `assets/preview.png` (1024x768). `preview` drives Chromium through Playwright; run `npx playwright install chromium` once if the browser is missing.
- Verification path: `npm run typecheck`, then `npm run build`, then unzip `package.zip` into `<workspace>/data/plugins/opencode-go-siyuan/` (`plugin.json` must sit directly inside it) and exercise it in SiYuan. `ACCEPTANCE.local.md` is the untracked manual checklist.

## Releasing

The version string is authoritative in `package.json` and `plugin.json`; CI fails when the two disagree. `src/opencode.ts` no longer holds a literal — `DEFAULT_PLUGIN_UA` gets its version from `plugin.json` at build time (`webpack.DefinePlugin` → `__PLUGIN_VERSION__`), so the identity the plugin sends always matches the installed build. The sample `User-Agent` lines in `README.md` and `README.zh-CN.md` are illustrative; update them with a version bump only to keep the docs readable.

Do not tag or publish by hand: pushing to `main` runs `.github/workflows/cd.yml`, which rejects a version lower than the newest `v*` tag, skips the release when it is unchanged, and otherwise creates the tag and the GitHub release itself. Release notes are generated from commit subjects by `scripts/release-notes.mjs`.

## Conventions

- Commit subjects are Conventional Commits in English and lowercase, with a scope naming the module touched (`provider`, `session`, `usage`, `inline`, `settings`, `dialog`, `preview`, `release`). Anything outside that shape is dumped into an "Other Changes" bucket in the release notes.
- Commit bodies explain the *why* and end with how the change was verified; recent ones are Chinese, and that mix is the house style — mirror the neighbouring commits.
- Source comments are Chinese. Indentation is 4 spaces, double quotes, semicolons; nothing enforces this automatically, so match the file you are editing.
- Every UI string needs a key in **both** `src/i18n/en.json` and `src/i18n/zh-CN.json`. The two files are key-for-key identical, and an unknown key renders as the raw key rather than falling back to another language.
- README images use absolute URLs (`https://gcore.jsdelivr.net/gh/<owner>/<repo>@main/assets/...`), never repo-relative paths: the packaged `README.md` sits in the archive root, where `assets/` does not exist, and the kernel falls back to a `/plugins/<name>/assets/...` URL that 404s. Use the `gcore.jsdelivr.net` CNAME rather than `cdn.jsdelivr.net`: the latter answered every probe with a `301` to `raw.githubusercontent.com`, which is unreliable from mainland China, while Gcore served the same file (byte-identical) directly. Both are jsDelivr endpoints — the kernel builds `cdn.jsdelivr.net` URLs for its own package images, but an absolute URL in a README passes through it untouched.
- `tsconfig.json` has `strictNullChecks: false` with `noImplicitAny: true`, and the bundle targets `es6`. Code that runs in SiYuan must not assume Node or Electron APIs.

## Architecture

- `siyuan` is a webpack **external**: runtime objects (`Plugin`, `fetchSyncPost`, `Setting`, `Dialog`, `openSetting`, `window.siyuan`) always come from the host. The npm package is a types-only dependency at build time.
- The plugin never touches SiYuan's configuration on its own. Creating, repairing or deleting the provider and writing `OPENCODE_GO_SESSION` all trace back to a button the user pressed; there is deliberately no "auto-inject on startup" switch, and a provider the user deleted stays deleted.
- The per-conversation header works by wrapping `window.fetch`: `src/session.ts` writes `{{vars.OPENCODE_GO_SESSION}}` before `/api/ai/agent/chat` (body `sessionID`) or `/api/ai/editor/chat` (body `taskID`) is allowed through. The wrapper must be restored on `onunload`, must be a no-op for every other request, and must let the request proceed when the variable write fails — losing cache affinity is acceptable, blocking a chat message is not.
- Every undocumented kernel API this plugin relies on is noted in a comment with the SiYuan file and version it was checked against; some of those APIs are missing from, or wrong in, the published typings. Do not "correct" such a call from the typings alone.
- The usage route `GET /v1/usage` is first-party but undocumented and its response shape has already changed once, so `src/types.ts` and `src/usage.ts` treat missing fields as *unknown*, never as 0. It is reached through `/api/network/forwardProxy` because the renderer cannot call it directly (no CORS headers, `404` on preflight).
- `src/inline.ts` and `src/providerIcon.ts` patch SiYuan's own DOM, keyed on internal class names and the base URL. Panels are rebuilt wholesale by the host, so both re-attach their observers instead of injecting once.
- Production builds deliberately keep every `console` call (`EsbuildPlugin` with `drop: []` / `pure: []`): diagnosability beats a few KB. The logger in `src/log.ts` is gated by the debug setting, dedupes by topic+message, and must never receive the API key.
