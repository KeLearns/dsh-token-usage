**[English](README.md) | [简体中文](README.zh.md)**

# @kelearns/dsh-token-usage

[![npm version](https://img.shields.io/npm/v/@kelearns/dsh-token-usage)](https://www.npmjs.com/package/@kelearns/dsh-token-usage)
[![License](https://img.shields.io/npm/l/@kelearns/dsh-token-usage)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-kelearns%2Fdsh--token--usage-181717?logo=github)](https://github.com/KeLearns/dsh-token-usage)

Token usage heatmap for the DeepSeek Harness (dsh) web GUI — a GitHub-style
contribution graph for daily / weekly / cumulative token consumption, with a
summary bubble, hover details, and activity insights. Mounted through the
official dsh plugin mechanism (`dsh plugin add`) — no dsh source changes.

A "Token Activity" entry appears in the settings sidebar.

## Screenshots

**Daily heatmap — dark theme, English (12-month window)**

<img src="screenshots/promo-en-dark-daily.png" width="612" alt="Daily token usage heatmap, dark theme, English">

**Three views — dark theme, English**

| Daily | Weekly | Cumulative |
|:---:|:---:|:---:|
| <img src="screenshots/promo-en-dark-daily.png" width="200" alt="Daily view"> | <img src="screenshots/promo-en-dark-weekly.png" width="200" alt="Weekly view"> | <img src="screenshots/promo-en-dark-cum.png" width="200" alt="Cumulative view"> |

**Light theme & Chinese UI**

| Light (English) | 深色主题（简体中文） |
|:---:|:---:|
| <img src="screenshots/promo-en-light-daily.png" width="300" alt="Light theme, English"> | <img src="screenshots/promo-zh-dark-daily.png" width="300" alt="Dark theme, Chinese"> |

## Features

- **Summary bubble** — one rounded container with 5 statistics divided by
  vertical rules: total / peak-day / longest session / current streak / longest streak;
- **Three views** — Daily (per-day color levels), Weekly (per-week stacked
  cells: week total ÷ (max week / 7) cells, deepest color), Cumulative
  (per-week cumulative stack: total ÷ 7 per cell, newest column always full);
- **Window switch** — last 3 / 6 / 12 months (default 12); fixed 12px cells,
  12-month view scrolls horizontally and auto-scrolls to the latest week;
- **Hover details** — hovering a cell shows that day's total, that week's
  total, or the week-to-date cumulative as of that day (localized zh/en);
- **Activity insights** — most used model / reasoning effort / tool, peak
  hour, daily & monthly averages, most active weekday, most active day;
  sorted by label length, two equal columns with a continuous center divider;
- **i18n** — zh / en, follows the document language live;
- **Themes** — light & dark palettes, follows the dsh application theme;
- **Auto refresh** — re-scans changed session files every 60s and on focus;
- **Cross-platform** — pure Node stdlib on the host side (`fs` / `path` / `os` / `zlib`), works on Windows, macOS and Linux; the browser half is platform-agnostic.

## Install (official mechanism)

Requires pnpm on PATH:

```powershell
npm install -g pnpm
```

From npm (recommended):

```powershell
dsh plugin --profile web add @kelearns/dsh-token-usage
```

Local development install (run from this repository's root — `link:.`
resolves to the current directory):

```powershell
dsh plugin --profile web add link:.
```

Remove:

```powershell
dsh plugin --profile web remove @kelearns/dsh-token-usage
```

> The installer reads `cordis.patch.yml` (the `dsh.bundle.patch` manifest
> field) and applies the plugin row automatically — no manual patch editing.
> Restart dsh web to activate.

### Manual equivalent (no CLI)

1. Put the package into the profile node_modules:
   `$DSH_HOME/profiles/web/node_modules/@kelearns/dsh-token-usage`;
2. Append this block to `$DSH_HOME/cordis.patch.yml` (idempotent):

```yaml
- insert:
    - id: dsh-token-usage
      name: '@kelearns/dsh-token-usage'
```

3. Restart dsh web.

## Data source

`$DSH_HOME`/sessions/<workspace>/<session-id>/session.jsonl.zstd
(the official dsh JSONL persistence: concatenated zstd frames; first line is
the session header, followed by the event stream).

Token usage is folded from `assistant/chunk` events with
`chunk.type === "usage"` (`usage { inputTokens, outputTokens, cacheReadTokens }`)
attributed to local days by event `time` (epoch ms). Total = input + output + cache read.
Insights additionally read `request/header` (model / reasoning effort),
`tool/call` (tools) and usage timestamps (peak hour / weekday).

Per-file results are cached by `(size, mtimeMs)`; rescans only re-decode
changed (active) sessions.

## Routes (same-origin)

| Method | Path | Description |
|---|---|---|
| GET | /dsh-token-usage/stats | Full statistics: `{ totals, stats, insights, today, days:[{d,i,o,c,a}], scan }` |
| POST | /dsh-token-usage/refresh | Force cache invalidation and rescan |
| GET | /dsh-token-usage/status | Cache / last scan state |

## Configuration

```yaml
- insert:
    - id: dsh-token-usage
      name: '@kelearns/dsh-token-usage'
      config:
        refreshIntervalMinutes: 5   # background rescan interval (default 5)
```

## Tests

```powershell
node test/mock.test.mjs                                   # synthetic full pipeline
node test/mock.test.mjs "$env:USERPROFILE\.dsh"  # real-data smoke (any DSH_HOME)
node test/layout-algo.mjs                                  # layout algorithm matrix
```

## Known limitations

- Counts sessions that carry usage events (dsh session log format, verified on 0.1.0-rc.6);
- Days are attributed in the process local timezone; weeks start on Monday;
- zstd decompression requires Node >= 22.2 (satisfied by the official dsh runtime);
- Missing/unreadable session directories yield empty statistics without affecting the GUI.

## License

MIT