import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenRouterModel, OpenRouterEndpoint } from "./types.js";

/**
 * Disk cache for the OpenRouter catalog so startup never has to wait on the
 * network. Stores the raw API payloads (not the derived pi model configs) so
 * the catalog is always rebuilt through the same conversion path, including
 * pi's built-in model metadata merges.
 *
 * All reads/writes are best-effort: a missing or corrupt cache simply means
 * the next sync falls back to the network.
 */
export const CATALOG_CACHE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "openrouter-catalog-cache.json",
);

export interface CatalogCacheFile {
  version: number;
  updatedAt: string;
  models: OpenRouterModel[];
  /** Raw /models/<id>/endpoints responses, keyed by model id (enriched models). */
  endpoints: Record<string, OpenRouterEndpoint[]>;
}

const CACHE_VERSION = 1;

export function loadCatalogCache(): CatalogCacheFile | null {
  try {
    if (!existsSync(CATALOG_CACHE_PATH)) return null;
    const raw = JSON.parse(readFileSync(CATALOG_CACHE_PATH, "utf8"));
    if (!raw || raw.version !== CACHE_VERSION) return null;
    if (!Array.isArray(raw.models) || raw.models.length === 0) return null;

    const models = raw.models.filter(
      (m: unknown): m is OpenRouterModel =>
        !!m && typeof (m as OpenRouterModel).id === "string" && (m as OpenRouterModel).id.length > 0,
    );
    if (models.length === 0) return null;

    const endpoints: Record<string, OpenRouterEndpoint[]> = {};
    if (raw.endpoints && typeof raw.endpoints === "object" && !Array.isArray(raw.endpoints)) {
      for (const [id, value] of Object.entries(raw.endpoints as Record<string, unknown>)) {
        if (Array.isArray(value)) endpoints[id] = value as OpenRouterEndpoint[];
      }
    }

    return {
      version: CACHE_VERSION,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      models,
      endpoints,
    };
  } catch {
    return null;
  }
}

export function saveCatalogCache(
  models: OpenRouterModel[],
  endpoints: Record<string, OpenRouterEndpoint[]>,
): void {
  try {
    const payload: CatalogCacheFile = {
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      models,
      endpoints,
    };
    mkdirSync(dirname(CATALOG_CACHE_PATH), { recursive: true });
    // Write via a temp file + rename so a crash mid-write never corrupts the cache.
    const tmpPath = `${CATALOG_CACHE_PATH}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload) + "\n");
    renameSync(tmpPath, CATALOG_CACHE_PATH);
  } catch {
    // Persistence is best-effort; never break sync over a write failure.
  }
}
