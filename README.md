![Preview](https://raw.githubusercontent.com/Ray4AI/pi-openrouter-plus/main/assets/preview.png)

# pi-openrouter-realtime (Ray4AI fork)

> **Fork note:** this is a personal fork of [olixis/pi-openrouter-plus](https://github.com/olixis/pi-openrouter-plus).
> The upstream extension is unchanged; the fork adds **persistent enrichments**, **multi-model enrichment**,
> and the **`/openrouter-diminish`** command (see [Fork additions](#fork-additions) below).
> Upstream changelog for v0.3.0 – v0.3.7 is preserved further down.

Pi extension for OpenRouter that loads the latest models from OpenRouter in real time, with provider/quantization enrichment, endpoint health indicators, credit balance display, interactive model picker, and tab-completion.

Once the extension is installed and your OpenRouter credential is configured in pi, each new pi session automatically fetches the latest OpenRouter model list.

Npm package (upstream only — the fork is distributed via GitHub):

- `pi-openrouter-realtime`

## Fork additions

### Persistent enrichments (saved default models survive restarts)

Enriched `@or:*` variant IDs used to be memory-only: if you saved one as your default model
(`Ctrl+S` in the model picker), a new session could not resolve it and pi silently fell back to the
first model in the catalog.

- Enriched model IDs are persisted to `~/.pi/agent/openrouter-enriched.json` after every successful enrich
- Restored automatically at **extension load** (before pi resolves the saved default model / scoped
  patterns) and refreshed on `session_start`
- Load-time restore reads the API key from `OPENROUTER_API_KEY` **or** `~/.pi/agent/auth.json`
  (covers `pi /login openrouter` setups)
- Restore failures degrade silently to the plain catalog — startup never breaks
- All state lives in that single file; uninstalling the extension leaves no other traces, and
  reinstalling restores the same enrichment set

### Multi-model enrich with merge semantics

`/openrouter-enrich` now accepts several model IDs (comma or space separated) and **merges** with
previously enriched models instead of replacing them. Enriching a second model no longer drops the
first model's variants (including a saved default model's variants).

### `/openrouter-diminish`

Remove the provider/quantization variants of specific enriched models without resetting everything:

- Accepts one or more comma-separated model IDs; IDs that are not currently enriched are reported and skipped
- With no args, opens the picker restricted to currently enriched models; tab completion lists enriched models only
- When nothing remains enriched, the plain catalog is restored automatically

---

## What's New in v0.3.7

- **Fixed DeepSeek V4 Flash reasoning levels** — live OpenRouter sync now preserves Pi's built-in OpenRouter metadata so `deepseek/deepseek-v4-flash` exposes only `none`, `high`, and `xhigh`
- **Preserved model compatibility metadata** — synced and enriched OpenRouter entries now keep built-in `thinkingLevelMap`, compatibility flags, base URL, API, and headers when Pi already knows the model
- **Fixed enriched variants for special reasoning models** — provider/quantization variants inherit the base model's reasoning-level map and DeepSeek-compatible request format

## What's New in v0.3.6

- **Fixed scoped models on startup** — the live OpenRouter catalog is now registered during extension load, before Pi resolves saved scoped-model patterns
- **Fixes disappearing new models** — models that are not yet in Pi's built-in OpenRouter list, such as `perceptron/perceptron-mk1`, remain available in scoped models after closing and reopening Pi

## What's New in v0.3.5

- **Fixed reasoning-level availability** — OpenRouter models are now marked as reasoning-capable when the live API advertises `reasoning`, `include_reasoning`, or `reasoning_effort` in `supported_parameters`
- **Fixed enriched variant reasoning** — provider/quantization variants now preserve endpoint reasoning support so Pi's thinking-level selector stays available
- **Updated Pi package imports** — moved extension imports and package metadata from the old `@mariozechner/*` package names to `@earendil-works/*`

## What's New in v0.3.4

- **Changelog correction** — fixed the README version notes so v0.3.3 now correctly describes the balance-output fix

## What's New in v0.3.3

- **Clearer `/openrouter-balance` output** — account-wide credit totals are now clearly separated from current API-key usage
- **Fixed misleading labels** — `All-time` is now shown as `All-time for this key`, and balance lines now distinguish account credits from key limits
- **Less confusing account display** — `Remaining`/`Spend limit` now explicitly say they refer to the API key limit

## What's New in v0.3.2

- **Context-safe info messages** — OpenRouter info panels still display in the UI, but are filtered out before LLM requests
- **Lower token waste** — `/openrouter-preview`, `/openrouter-balance`, and `/openrouter-status` no longer consume context window space unnecessarily
- **Less prompt contamination** — read-only extension output no longer gets echoed back into future model turns unless you explicitly include it

How it works:

- The extension still emits `openrouter-info` messages so you can see rich output in-session
- Before each LLM call, a `context` hook removes those `openrouter-info` custom messages from the message list
- Result: visible UX for humans, but no extra prompt baggage for the model

## What's New in v0.3.1

- **Fixed variant counting** — enriched variants are no longer presented as both base models and `+N variants`
- **Clearer totals** — status/output now distinguishes total registered models from variant count
- **Less intrusive account output** — removed the key label / redacted API-key style line from account/status output

## What's New in v0.3.0

- **Targeted enrichment** — enrich one model on demand without scanning the whole catalog
- **Interactive model picker** — run `/openrouter-enrich` without args → type a search query → pick from filtered results
- **Tab-completion** — autocomplete model IDs when typing commands
- **`/openrouter-preview`** — inspect provider variants and endpoint health without changing your model list
- **`/openrouter-balance`** — check your OpenRouter credit balance and usage
- **`/openrouter-status`** — see current extension state, active enrichments, cache age
- **Endpoint health data** — status, uptime, latency (TTFT), throughput per variant
- **Snapshot-based routing** — eliminates race conditions with stale route maps
- **Transactional sync** — state only updates on success, never left in a broken state
- **Fixed cost parsing** — missing pricing no longer shows as "free"
- **Auth detection fix** — works with both env vars and auth.json
- **Fetch timeouts** — 15s timeout prevents hanging on OpenRouter API issues
- **HTTP-Referer / X-Title headers** — proper app identification with OpenRouter

## Features

- Loads the latest OpenRouter model list into pi in real time
- Keeps startup behavior fast by default
- Adds provider-specific variants on demand
- Adds quantization-specific variants for chosen models
- Enriches several models at once, merging with existing enrichments
- Persists enrichments across restarts, so saved default models resolve correctly
- Removes individual model enrichments with `/openrouter-diminish`
- Routes enriched selections through OpenRouter provider routing
- Shows endpoint health: status, uptime, latency, throughput, caching support
- Displays credit balance and usage statistics
- Interactive model selection with searchable picker
- Tab-completes model IDs for all commands

## Install

### 1) Install the extension

From npm:

```bash
pi install npm:pi-openrouter-realtime
```

From this fork (recommended for the fork features):

```bash
pi install git:github.com/Ray4AI/pi-openrouter-plus
```

From upstream:

```bash
pi install git:github.com/olixis/pi-openrouter-plus
```

### 2) Connect pi to OpenRouter

#### Recommended: use `pi-connect` to set up OpenRouter

The `git:github.com/hk-vk/pi-connect` package makes provider setup much easier and gives you a simple `/connect` flow inside pi.

Install it:

```bash
pi install git:github.com/hk-vk/pi-connect
```

Then open pi and connect OpenRouter:

```bash
pi
/connect openrouter
```

When prompted:

1. Paste your OpenRouter API key
2. Confirm/save it
3. Start a new pi session, or restart the current one

`pi-connect` stores the credential in `~/.pi/agent/auth.json`, and this extension will then automatically fetch the latest models from OpenRouter when pi starts.

#### Official pi ways to connect OpenRouter

Pi supports OpenRouter via either an environment variable or `~/.pi/agent/auth.json`.

Using an environment variable:

```bash
export OPENROUTER_API_KEY=sk-or-...
pi
```

Using `~/.pi/agent/auth.json`:

```json
{
  "openrouter": { "type": "api_key", "key": "sk-or-..." }
}
```

After the key is available, this extension automatically syncs the latest OpenRouter model list at session start.

### 3) Try without installing

```bash
pi -e npm:pi-openrouter-realtime
```

or:

```bash
pi -e git:github.com/Ray4AI/pi-openrouter-plus
```

## Commands

| Command | Description |
|---|---|
| `/openrouter-sync` | Fetch latest OpenRouter models and restore the plain model list (clears all enrichments) |
| `/openrouter-enrich <model-id> [<model-id> ...]` | Add provider/quantization variants for one or more models (comma or space separated) |
| `/openrouter-enrich` | Search → pick a model interactively (no args) |
| `/openrouter-diminish <model-id> [<model-id> ...]` | Remove provider/quantization variants for one or more enriched models |
| `/openrouter-diminish` | Pick from currently enriched models to diminish (no args) |
| `/openrouter-preview <model-id>` | Preview endpoint variants with health data (read-only) |
| `/openrouter-preview` | Search → pick a model to preview (no args) |
| `/openrouter-balance` | Show credit balance, remaining funds, and usage breakdown |
| `/openrouter-status` | Show extension state: model count, enrichments, cache age |

## Examples

### Enrich a model

```bash
/openrouter-enrich kwaipilot/kat-coder-pro-v2
```

This keeps the normal OpenRouter catalog and adds variants like:

- `StreamLake — Kwaipilot: KAT-Coder-Pro V2`
- `AtlasCloud · fp8 — Kwaipilot: KAT-Coder-Pro V2`

Enrich more than one model at a time (existing enrichments are preserved):

```bash
/openrouter-enrich kwaipilot/kat-coder-pro-v2, deepseek/deepseek-r1
```

### Remove enrichment for specific models

```bash
/openrouter-diminish deepseek/deepseek-r1
```

Only `deepseek/deepseek-r1` loses its variants; other enriched models stay registered. Run it with no
arguments to pick from the list of currently enriched models, or `/openrouter-sync` to drop everything.

### Preview endpoints before enriching

```bash
/openrouter-preview deepseek/deepseek-r1
```

Shows provider variants with pricing and health data:

```
DeepSeek: DeepSeek R1 (deepseek/deepseek-r1)
8 endpoints across 5 provider/quantization variants:

• DeepInfra — $0.55/M in · $2.19/M out · ✅ healthy · uptime: 99% · TTFT: 450ms · 85 tok/s
• DeepSeek — $0.55/M in · $2.19/M out · ✅ healthy · uptime: 100% · TTFT: 320ms · 120 tok/s · 📦 caching
• Fireworks · fp8 — $0.60/M in · $2.40/M out · ⚠️ degraded · uptime: 95% · TTFT: 600ms · 60 tok/s
```

### Check your balance

```bash
/openrouter-balance
```

## Behavior

- After the extension is installed and OpenRouter auth is configured, each new pi session syncs the latest OpenRouter model list automatically
- Enrichment merges: enriching a model keeps previously enriched models, and the active set is persisted to `~/.pi/agent/openrouter-enriched.json`
- Enriched variants are restored at startup, so a variant saved as the default model resolves in new sessions
- Quantization variants are exposed as separate model choices when available
- Enriched variants are translated into OpenRouter provider routing fields at request time
- Use `/openrouter-diminish` to remove individual enrichments, or `/openrouter-sync` to go back to the plain default list
- Preview output also includes search-related model info (id, name, terms, description) plus pricing and endpoint health

## Architecture (v0.3.x improvements + fork additions)

- **Snapshot-based routing** — the stream factory captures a frozen route map at registration time, eliminating race conditions when syncing
- **Generation counter** — overlapping sync calls are safely discarded if a newer sync has started
- **Transactional state** — caches are not cleared before fetch; state only commits on success
- **Auth-keyed caching** — model cache invalidates when the API key changes
- **Fetch timeouts** — all OpenRouter API calls have a 15-second timeout via AbortController
- **Merged enrichment catalog** (`buildMergedCatalog`) — base catalog plus per-model variants built in one pass; a single failed model is skipped and counted, never fatal
- **Persisted enrichment state** — `~/.pi/agent/openrouter-enriched.json` is the only on-disk artifact of the extension beyond the install itself

## Development

Type-check locally:

```bash
bunx tsc --noEmit
```

or:

```bash
npx tsc --noEmit
```

Test the package locally with pi:

```bash
pi -e .
```

Or load the extension entry file directly:

```bash
pi -e ./extensions/openrouter-routing/index.ts
```

## License

MIT

---

> ⁶ Jesus said unto him, I am the way, the truth, and the life: no man comes unto the Father, but by me.
>
> — *John 14:6*
