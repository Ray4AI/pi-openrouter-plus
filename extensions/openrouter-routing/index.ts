import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OPENROUTER_BASE_URL,
  PROVIDER_NAME,
  type ProviderModelConfig,
  type RouteVariant,
} from "./types.js";
import { invalidateAllCaches, fetchKeyInfo, fetchCredits, fetchModels, fetchModelEndpoints } from "./api.js";
import { toProviderModel, groupEndpoints, formatEndpointHealth, parseCost, enrichModel } from "./models.js";
import { createStreamFactory } from "./routing.js";
import { createModelPicker, rankModelsForQuery } from "./picker.js";
import {
  getSnapshot,
  nextGeneration,
  isStale,
  buildPlainSync,
  commitSnapshot,
  getCachedModelList,
} from "./state.js";

const REFERER_HEADER = "https://github.com/olixis/pi-openrouter-plus";
const APP_TITLE = "pi-openrouter-realtime";
const OPENROUTER_INFO_MESSAGE_TYPE = "openrouter-info";

// ---------- Enrichment persistence (survive restarts) ----------

const ENRICHED_STATE_PATH = join(homedir(), ".pi", "agent", "openrouter-enriched.json");

function loadPersistedEnrichedModels(): string[] {
  try {
    if (!existsSync(ENRICHED_STATE_PATH)) return [];
    const raw = JSON.parse(readFileSync(ENRICHED_STATE_PATH, "utf8"));
    const ids = Array.isArray(raw?.enrichedModelIds) ? raw.enrichedModelIds : [];
    return ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function persistEnrichedModels(enrichedModelIds: ReadonlySet<string>) {
  try {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      enrichedModelIds: Array.from(enrichedModelIds),
    };
    mkdirSync(dirname(ENRICHED_STATE_PATH), { recursive: true });
    writeFileSync(ENRICHED_STATE_PATH, JSON.stringify(payload, null, 2) + "\n");
  } catch {
    // Persistence is best-effort; never break sync over a write failure.
  }
}

function readApiKeyFromAuthFile(): string | undefined {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return undefined;
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const entry = auth?.openrouter;
    if (typeof entry?.key === "string" && entry.key) return entry.key;
    if (typeof entry?.accessToken === "string" && entry.accessToken) return entry.accessToken;
    return undefined;
  } catch {
    return undefined;
  }
}

function clearPersistedEnrichedModels() {
  try {
    // Overwrite with an empty list so stale IDs are never restored.
    persistEnrichedModels(new Set());
  } catch {
    // best-effort
  }
}

function emitMessage(pi: ExtensionAPI, text: string) {
  pi.sendMessage({
    customType: OPENROUTER_INFO_MESSAGE_TYPE,
    content: text,
    display: true,
  });
}

function sanitizeSearchText(text?: string): string {
  return (text || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function maxDefined(values: Array<number | undefined>, fallback?: number): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  if (defined.length > 0) return Math.max(...defined);
  return fallback;
}

function formatPerMillion(cost: number): string {
  if (cost === 0) return "$0/M";
  if (cost < 0.01) return `$${cost.toFixed(4)}/M`;
  if (cost < 1) return `$${cost.toFixed(3)}/M`;
  return `$${cost.toFixed(2)}/M`;
}

function buildPricingParts(
  input?: number,
  output?: number,
  cacheRead?: number,
  cacheWrite?: number,
): string[] {
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${formatPerMillion(input)} in`);
  if (output !== undefined) parts.push(`${formatPerMillion(output)} out`);
  if (cacheRead !== undefined) parts.push(`${formatPerMillion(cacheRead)} cache-read`);
  if (cacheWrite !== undefined) parts.push(`${formatPerMillion(cacheWrite)} cache-write`);
  return parts;
}

function buildPreviewSearchInfo(target: { id: string; name: string; description?: string; pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } }): string[] {
  const tokenizedId = target.id.replace(/[/:_.-]+/g, " ");
  const terms = Array.from(new Set([target.id, tokenizedId, target.name].map(sanitizeSearchText).filter(Boolean)));
  const lines = [
    "**Search info**",
    `- Searchable id: ${target.id}`,
    `- Searchable name: ${target.name}`,
  ];

  if (terms.length > 0) {
    lines.push(`- Search terms: ${terms.join(" | ")}`);
  }

  const basePricing = buildPricingParts(
    parseCost(target.pricing?.prompt),
    parseCost(target.pricing?.completion),
    parseCost(target.pricing?.input_cache_read),
    parseCost(target.pricing?.input_cache_write),
  );
  if (basePricing.length > 0) {
    lines.push(`- Base pricing: ${basePricing.join(" · ")}`);
  }

  if (target.description) {
    lines.push(`- Description: ${sanitizeSearchText(target.description)}`);
  }

  return lines;
}

function buildVariantPricingInfo(target: { pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } }, endpoints: Array<{ pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } }>): string {
  const input = maxDefined(endpoints.map((e) => parseCost(e.pricing?.prompt)), parseCost(target.pricing?.prompt));
  const output = maxDefined(endpoints.map((e) => parseCost(e.pricing?.completion)), parseCost(target.pricing?.completion));
  const cacheRead = maxDefined(endpoints.map((e) => parseCost(e.pricing?.input_cache_read)), parseCost(target.pricing?.input_cache_read));
  const cacheWrite = maxDefined(endpoints.map((e) => parseCost(e.pricing?.input_cache_write)), parseCost(target.pricing?.input_cache_write));
  return buildPricingParts(input, output, cacheRead, cacheWrite).join(" · ");
}

export default async function openrouterModelsExtension(pi: ExtensionAPI) {
  // ---------- Keep extension info messages out of LLM context ----------

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter(
        (message: any) =>
          !(message.role === "custom" && message.customType === OPENROUTER_INFO_MESSAGE_TYPE),
      ),
    };
  });

  // ---------- Provider registration ----------

  function registerWithSnapshot(
    models: ProviderModelConfig[],
    routes: ReadonlyMap<string, RouteVariant>,
  ) {
    pi.registerProvider(PROVIDER_NAME, {
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: "OPENROUTER_API_KEY",
      api: "openai-completions",
      models,
      headers: {
        "HTTP-Referer": REFERER_HEADER,
        "X-Title": APP_TITLE,
      },
      streamSimple: createStreamFactory(routes),
    });
  }

  // ---------- Core sync logic ----------

  /**
   * Build a catalog consisting of the full base model list plus the merged
   * endpoint variants of every model in enrichedIds. Returns null when the
   * generation became stale (a newer sync started); never throws for
   * per-model failures — those are counted in endpointFailures.
   */
  async function buildMergedCatalog(
    enrichedIds: string[],
    apiKey: string | undefined,
    generation: number,
  ): Promise<{
    models: ProviderModelConfig[];
    routes: Map<string, RouteVariant>;
    enrichedModelIds: Set<string>;
    endpointFailures: number;
  } | null> {
    // Fetch the base catalog once (cached unless forced elsewhere).
    const rawModels = await fetchModels(apiKey, false);
    if (isStale(generation)) return null;
    const baseModels = rawModels.map(toProviderModel);

    const routes = new Map<string, RouteVariant>();
    const variants: ProviderModelConfig[] = [];
    const enrichedModelIds = new Set<string>();
    let endpointFailures = 0;

    for (const modelId of enrichedIds) {
      try {
        const enriched = await enrichModel(rawModels, modelId, apiKey);
        if (isStale(generation)) return null;
        for (const [key, route] of enriched.routes) routes.set(key, route);
        variants.push(...enriched.variants);
        enrichedModelIds.add(modelId);
        endpointFailures += enriched.endpointFailures;
      } catch {
        // Model vanished from the catalog or endpoints unavailable — skip it
        // but keep the rest of the merged catalog intact.
        endpointFailures += 1;
      }
    }

    return {
      models: [...baseModels, ...variants],
      routes,
      enrichedModelIds,
      endpointFailures,
    };
  }

  async function bootstrapPlainSync() {
    const generation = nextGeneration();

    try {
      // Register the live OpenRouter catalog during extension load so Pi can
      // resolve saved scoped-model patterns before session_start fires.
      // The models endpoint is public, and session_start refreshes again with
      // the configured API key when one is available.
      const result = await buildPlainSync(process.env.OPENROUTER_API_KEY, true);

      if (isStale(generation)) return;
      commitSnapshot(generation, result.models, result.routes);
      registerWithSnapshot(result.models, result.routes);
    } catch {
      // Keep startup resilient. If OpenRouter is temporarily unavailable, Pi's
      // built-in OpenRouter list remains registered and manual /openrouter-sync
      // can recover later.
    }
  }

  await bootstrapPlainSync();

  // Best-effort restore at load time so persisted variants are registered
  // before Pi resolves the saved default model / scoped patterns.
  // Auth may come from env OR ~/.pi/agent/auth.json (pi /login openrouter).
  const loadApiKey = process.env.OPENROUTER_API_KEY || readApiKeyFromAuthFile();
  if (loadPersistedEnrichedModels().length > 0 && loadApiKey) {
    await restoreEnriched(
      {
        modelRegistry: { getApiKeyForProvider: async () => loadApiKey },
        ui: { notify: () => {} },
      },
      true,
    );
  }

  async function syncPlain(ctx: any, silent = false, force = false) {
    const generation = nextGeneration();

    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      if (!silent) ctx.ui.notify("Fetching OpenRouter models...", "info");

      const result = await buildPlainSync(apiKey, force);

      if (isStale(generation)) return;
      commitSnapshot(generation, result.models, result.routes);
      registerWithSnapshot(result.models, result.routes);
      clearPersistedEnrichedModels();

      if (!silent) {
        ctx.ui.notify(`OpenRouter: ${result.modelCount} models synced`, "info");
      }
    } catch (err: any) {
      if (!silent) ctx.ui.notify(`OpenRouter sync failed: ${err?.message}`, "error");
    }
  }

  async function syncEnriched(ctx: any, targetModelIds: string[]) {
    const generation = nextGeneration();

    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      const label = targetModelIds.join(", ");
      ctx.ui.notify(`Fetching endpoint variants for ${label}...`, "info");

      // Start from the requested set PLUS already-enriched models so an
      // enrich never silently drops earlier enrichments (or the saved
      // default model's variants).
      const mergedIds = new Set<string>([
        ...loadPersistedEnrichedModels(),
        ...targetModelIds,
      ]);

      const result = await buildMergedCatalog(Array.from(mergedIds), apiKey, generation);
      if (result === null) return;

      commitSnapshot(generation, result.models, result.routes, result.enrichedModelIds);
      registerWithSnapshot(result.models, result.routes);
      persistEnrichedModels(result.enrichedModelIds);

      const failuresText =
        result.endpointFailures > 0 ? `, ${result.endpointFailures} endpoint failures` : "";
      const enrichedList = Array.from(result.enrichedModelIds).join(", ");
      const totalRegistered = result.models.length;
      ctx.ui.notify(
        `OpenRouter: ${totalRegistered} models registered (${result.routes.size} variants) [${enrichedList}]${failuresText}`,
        "info",
      );
    } catch (err: any) {
      ctx.ui.notify(`OpenRouter enrich failed: ${err?.message}`, "error");
    }
  }

  async function diminishEnriched(ctx: any, targetModelIds: string[]) {
    const generation = nextGeneration();

    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      const label = targetModelIds.join(", ");

      const current = new Set(loadPersistedEnrichedModels());
      const unknown = targetModelIds.filter((id) => !current.has(id));
      if (unknown.length > 0) {
        ctx.ui.notify(
          `Not enriched (nothing to diminish): ${unknown.join(", ")}`,
          "warning",
        );
        if (unknown.length === targetModelIds.length) return;
      }

      for (const id of targetModelIds) current.delete(id);
      ctx.ui.notify(`Removing endpoint variants for ${label}...`, "info");

      if (current.size === 0) {
        // Nothing left enriched — restore the plain catalog (same as sync).
        const result = await buildPlainSync(apiKey, false);
        if (isStale(generation)) return;
        commitSnapshot(generation, result.models, result.routes);
        registerWithSnapshot(result.models, result.routes);
        clearPersistedEnrichedModels();
        ctx.ui.notify(
          `OpenRouter: variants removed for ${label}; plain catalog restored (${result.modelCount} models)`,
          "info",
        );
        return;
      }

      const result = await buildMergedCatalog(Array.from(current), apiKey, generation);
      if (result === null) return;

      commitSnapshot(generation, result.models, result.routes, result.enrichedModelIds);
      registerWithSnapshot(result.models, result.routes);
      persistEnrichedModels(result.enrichedModelIds);

      ctx.ui.notify(
        `OpenRouter: variants removed for ${label}; ${result.routes.size} variants remain [${Array.from(result.enrichedModelIds).join(", ")}]`,
        "info",
      );
    } catch (err: any) {
      ctx.ui.notify(`OpenRouter diminish failed: ${err?.message}`, "error");
    }
  }

  // ---------- Autocomplete helper ----------

  function parseModelIds(args: string): string[] {
    return args
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }

  function modelCompletions(prefix: string) {
    const cached = getCachedModelList();
    if (!cached) return null;

    const raw = prefix.trim();
    const ranked = rankModelsForQuery(cached, raw);

    return ranked.slice(0, 20).map((m) => ({
      value: m.id,
      label: m.id,
      description: m.name,
    }));
  }

  function enrichedModelCompletions(prefix: string) {
    const enriched = getSnapshot().enrichedModelIds;
    if (enriched.size === 0) return null;
    const cached = getCachedModelList();
    const byId = new Map((cached || []).map((m) => [m.id, m]));

    const raw = prefix.trim().toLowerCase();
    return Array.from(enriched)
      .filter((id) => id.toLowerCase().includes(raw))
      .slice(0, 20)
      .map((id) => ({
        value: id,
        label: id,
        description: byId.get(id)?.name || "enriched model",
      }));
  }

  // ---------- Interactive picker (overlay modal with fuzzy search) ----------

  async function pickModel(
    ctx: any,
    title: string,
    candidates?: string[],
  ): Promise<string | undefined> {
    let cached = getCachedModelList();
    if (candidates) {
      const byId = new Map((cached || []).map((m) => [m.id, m]));
      cached = candidates.map((id) => byId.get(id) || ({ id, name: id } as any));
    }
    if (!cached || cached.length === 0) {
      ctx.ui.notify("No models cached. Run /openrouter-sync first.", "warning");
      return undefined;
    }

    const result = await ctx.ui.custom(
      (tui: any, theme: any, keybindings: any, done: (result: string | null) => void) => {
        return createModelPicker(tui, theme, keybindings, done, cached, title);
      },
      {
        overlay: true,
        overlayOptions: {
          width: "80%" as const,
          maxHeight: "70%" as const,
          row: "14%" as const,
          col: "50%" as const,
          minWidth: 60,
        },
      },
    );

    return result || undefined;
  }

  // ---------- Restore enriched models on startup ----------

  async function restoreEnriched(ctx: any, silent = false) {
    const persisted = loadPersistedEnrichedModels();
    if (persisted.length === 0) return;

    const generation = nextGeneration();
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);

      // Re-run the plain sync first so the base catalog is fresh.
      const plain = await buildPlainSync(apiKey, false);
      if (isStale(generation)) return;

      const result = await buildMergedCatalog(persisted, apiKey, generation);
      if (result === null) return;

      if (result.routes.size > 0) {
        commitSnapshot(generation, result.models, result.routes, result.enrichedModelIds);
        registerWithSnapshot(result.models, result.routes);
        persistEnrichedModels(result.enrichedModelIds);
        if (!silent) {
          const enrichedList = Array.from(result.enrichedModelIds).join(", ");
          ctx.ui.notify(
            `OpenRouter: restored ${result.routes.size} variants [${enrichedList}]${
              result.endpointFailures > 0 ? ` (${result.endpointFailures} endpoint failures)` : ""
            }`,
            "info",
          );
        }
      } else {
        // All persisted enrichments failed — keep the plain catalog so
        // startup never breaks.
        commitSnapshot(generation, plain.models, plain.routes);
        registerWithSnapshot(plain.models, plain.routes);
      }
    } catch {
      // Never break startup over a failed restore; plain catalog remains active.
    }
  }

  // ---------- Auto-sync on session start ----------

  pi.on("session_start", async (_event, ctx) => {
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      if (apiKey) {
        await restoreEnriched(ctx, true);
        updateStatusBar(ctx);
      }
    } catch {
      // No auth configured — skip silently
    }
  });

  // ---------- Commands ----------

  pi.registerCommand("openrouter-sync", {
    description: "Fetch latest OpenRouter models and restore the plain model list",
    handler: async (_args, ctx) => {
      invalidateAllCaches();
      await syncPlain(ctx, false, true);
      updateStatusBar(ctx);
    },
  });

  pi.registerCommand("openrouter-enrich", {
    description:
      "Add provider/quantization variants for one or more models (comma-separated); no args opens the picker",
    getArgumentCompletions: modelCompletions,
    handler: async (args, ctx) => {
      const modelIds = parseModelIds(args);

      if (modelIds.length === 0) {
        const picked = await pickModel(ctx, "Search models to enrich");
        if (!picked) return;
        await syncEnriched(ctx, [picked]);
        updateStatusBar(ctx);
        return;
      }

      await syncEnriched(ctx, modelIds);
      updateStatusBar(ctx);
    },
  });

  pi.registerCommand("openrouter-diminish", {
    description:
      "Remove provider/quantization variants for one or more enriched models (comma-separated); no args picks from enriched models",
    getArgumentCompletions: enrichedModelCompletions,
    handler: async (args, ctx) => {
      const modelIds = parseModelIds(args);

      if (modelIds.length === 0) {
        const enriched = getSnapshot().enrichedModelIds;
        if (enriched.size === 0) {
          ctx.ui.notify("No enriched models to diminish.", "warning");
          return;
        }
        const picked = await pickModel(
          ctx,
          "Search enriched models to diminish",
          Array.from(enriched),
        );
        if (!picked) return;
        await diminishEnriched(ctx, [picked]);
        updateStatusBar(ctx);
        return;
      }

      await diminishEnriched(ctx, modelIds);
      updateStatusBar(ctx);
    },
  });

  pi.registerCommand("openrouter-preview", {
    description: "Preview provider/quantization variants for a model without changing the model list",
    getArgumentCompletions: modelCompletions,
    handler: async (args, ctx) => {
      let modelId = args.trim();

      if (!modelId) {
        const picked = await pickModel(ctx, "Search models to preview");
        if (!picked) return;
        modelId = picked;
      }

      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
        ctx.ui.notify(`Fetching endpoints for ${modelId}...`, "info");

        const models = await fetchModels(apiKey);
        const target = models.find((m) => m.id === modelId);
        if (!target) {
          ctx.ui.notify(`Model not found: ${modelId}`, "error");
          return;
        }

        const endpoints = await fetchModelEndpoints(modelId, apiKey, true);
        if (endpoints.length === 0) {
          ctx.ui.notify(`No endpoints found for ${modelId}`, "warning");
          return;
        }

        const groups = groupEndpoints(target, endpoints);
        const lines: string[] = [
          `**${target.name}** (${target.id})`,
          `${endpoints.length} endpoints across ${groups.length} provider/quantization variants:`,
          "",
        ];

        lines.push(...buildPreviewSearchInfo(target), "");
        lines.push("**Endpoint variants**", "");

        for (const group of groups) {
          const r = group.route;
          const label = r.quantization
            ? `${r.providerName} · ${r.quantization}`
            : r.providerName;
          const pricing = buildVariantPricingInfo(target, group.endpoints);
          const health = formatEndpointHealth(r);
          const details = [pricing, health].filter(Boolean).join(" · ");
          lines.push(`• **${label}**${details ? ` — ${details}` : ""}`);
        }

        emitMessage(pi, lines.join("\n"));
      } catch (err: any) {
        ctx.ui.notify(`Preview failed: ${err?.message}`, "error");
      }
    },
  });

  pi.registerCommand("openrouter-balance", {
    description: "Show your OpenRouter credit balance and usage",
    handler: async (_args, ctx) => {
      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
        if (!apiKey) {
          ctx.ui.notify("No OpenRouter API key configured", "warning");
          return;
        }

        const [info, credits] = await Promise.all([
          fetchKeyInfo(apiKey),
          fetchCredits(apiKey),
        ]);

        const lines: string[] = ["**OpenRouter Account**", ""];

        // OpenRouter exposes two different concepts here:
        // - /credits => account-level purchased credits and total account usage (management key only)
        // - /key     => current API key limits and usage counters
        if (credits && credits.total_credits !== undefined && credits.total_usage !== undefined) {
          const balance = credits.total_credits - credits.total_usage;
          lines.push(`💰 **Balance: $${balance.toFixed(4)}**`);
          lines.push(`   Account credits: $${credits.total_credits.toFixed(4)} — Account used: $${credits.total_usage.toFixed(4)}`);
        } else if (info.limit_remaining !== null && info.limit_remaining !== undefined) {
          lines.push(`💰 **Remaining key limit: $${info.limit_remaining.toFixed(4)}**`);
        }

        lines.push("");

        if (info.is_free_tier) lines.push("Tier: Free");

        if (info.limit !== null && info.limit !== undefined) {
          const limitStr = `$${info.limit.toFixed(2)}`;
          const resetStr = info.limit_reset ? ` (resets ${info.limit_reset})` : "";
          lines.push(`Key spend limit: ${limitStr}${resetStr}`);
        }

        if (
          info.usage !== undefined
          || info.usage_daily !== undefined
          || info.usage_monthly !== undefined
        ) {
          lines.push("");
          lines.push("**Current API key usage**");
          if (info.usage_daily !== undefined) {
            lines.push(`  Today: $${info.usage_daily.toFixed(4)}`);
          }
          if (info.usage_monthly !== undefined) {
            lines.push(`  This month: $${info.usage_monthly.toFixed(4)}`);
          }
          if (info.usage !== undefined) {
            lines.push(`  All-time for this key: $${info.usage.toFixed(4)}`);
          }
        }

        emitMessage(pi, lines.join("\n"));
      } catch (err: any) {
        ctx.ui.notify(`Balance check failed: ${err?.message}`, "error");
      }
    },
  });

  pi.registerCommand("openrouter-status", {
    description: "Show current extension state: synced models, active enrichments, cache age",
    handler: async (_args, _ctx) => {
      const snapshot = getSnapshot();
      const lines: string[] = ["**OpenRouter Extension Status**", ""];

      const totalModels = snapshot.models.length;
      const variantCount = snapshot.routes.size;
      const baseModelCount = Math.max(0, totalModels - variantCount);

      lines.push(`Models registered: ${totalModels}`);
      lines.push(`Base models: ${baseModelCount}`);
      lines.push(`Variants registered: ${variantCount}`);

      if (snapshot.enrichedModelIds.size > 0) {
        lines.push(`Enriched models: ${Array.from(snapshot.enrichedModelIds).join(", ")}`);
      } else {
        lines.push("Enriched models: none");
      }

      if (snapshot.timestamp > 0) {
        const ageMin = Math.round((Date.now() - snapshot.timestamp) / 60000);
        lines.push(`Last sync: ${ageMin} minute(s) ago`);
      } else {
        lines.push("Last sync: never");
      }

      emitMessage(pi, lines.join("\n"));
    },
  });

  // ---------- Status bar ----------

  function updateStatusBar(ctx: any) {
    const snapshot = getSnapshot();
    if (snapshot.models.length > 0) {
      const variantCount = snapshot.routes.size;
      const enrichLabel = variantCount > 0 ? ` (${variantCount} variants)` : "";
      try {
        ctx.ui.setStatus("openrouter", `OR: ${snapshot.models.length} models${enrichLabel}`);
      } catch {
        // setStatus may not be available in all UI modes
      }
    }
  }
}
