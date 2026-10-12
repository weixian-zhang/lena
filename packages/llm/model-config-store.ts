import type { Database } from "@lena/datastore";
import {
  assertValidProviderConfig,
  type ProviderConfig,
} from "./provider-config.js";

/** Loads and saves the configured providers and their models. */
export interface ModelConfigStore {
  /** Every configured provider, keyed by the provider id requests route on. */
  readonly providers: ReadonlyMap<string, ProviderConfig>;
  /** Validates, then replaces the provider and all its models; invalid input writes nothing. */
  saveProvider(id: string, config: ProviderConfig): Promise<void>;
}

/** Keeps provider and model config in Lena's database, SQLite or Postgres alike. */
export class SqlModelConfigStore implements ModelConfigStore {
  /** Creates the tables if missing, then reads and validates every provider; throws on an invalid row. */
  static async load(database: Database): Promise<SqlModelConfigStore> {
    await database.execute(CREATE_PROVIDERS_TABLE);
    await database.execute(CREATE_MODELS_TABLE);

    const providerRows = await database.query<ProviderRow>(
      "SELECT id, kind, resource, auth FROM llm_providers ORDER BY id",
    );
    const modelRows = await database.query<ModelRow>(
      "SELECT provider_id, id, name, api, context_window, max_tokens, reasoning FROM llm_models ORDER BY provider_id, position",
    );

    const providers = new Map<string, ProviderConfig>();
    for (const row of providerRows) {
      const config: unknown = {
        kind: row.kind,
        resource: row.resource,
        auth: parseAuthColumn(row),
        models: modelRows
          .filter((model) => model.provider_id === row.id)
          .map(toModelConfig),
      };
      assertValidProviderConfig(row.id, config);
      providers.set(row.id, config);
    }
    return new SqlModelConfigStore(database, providers);
  }

  private constructor(
    private readonly database: Database,
    private readonly providersById: Map<string, ProviderConfig>,
  ) {}

  get providers(): ReadonlyMap<string, ProviderConfig> {
    return this.providersById;
  }

  async saveProvider(id: string, config: ProviderConfig): Promise<void> {
    assertValidProviderConfig(id, config);

    await this.database.execute(
      "INSERT INTO llm_providers (id, kind, resource, auth) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, resource = excluded.resource, auth = excluded.auth",
      [id, config.kind, config.resource, JSON.stringify(config.auth)],
    );
    // Removing model rows is config, not an Azure resource.
    await this.database.execute(
      "DELETE FROM llm_models WHERE provider_id = $1",
      [id],
    );
    for (const [position, model] of config.models.entries()) {
      await this.database.execute(
        "INSERT INTO llm_models (provider_id, position, id, name, api, context_window, max_tokens, reasoning) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          id,
          position,
          model.id,
          model.name ?? null,
          model.api,
          model.contextWindow,
          model.maxTokens,
          model.reasoning ? 1 : 0,
        ],
      );
    }
    this.providersById.set(id, config);
  }
}

// Types both SQLite and Postgres accept, so one statement serves both backends.
const CREATE_PROVIDERS_TABLE = `CREATE TABLE IF NOT EXISTS llm_providers (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  resource  TEXT NOT NULL,
  auth      TEXT NOT NULL
)`;

const CREATE_MODELS_TABLE = `CREATE TABLE IF NOT EXISTS llm_models (
  provider_id     TEXT NOT NULL REFERENCES llm_providers(id),
  id              TEXT NOT NULL,
  position        INTEGER NOT NULL,
  name            TEXT,
  api             TEXT NOT NULL,
  context_window  INTEGER NOT NULL,
  max_tokens      INTEGER NOT NULL,
  reasoning       INTEGER NOT NULL,
  PRIMARY KEY (provider_id, id)
)`;

type ProviderRow = { id: string; kind: string; resource: string; auth: string };

type ModelRow = {
  provider_id: string;
  id: string;
  name: string | null;
  api: string;
  context_window: number;
  max_tokens: number;
  reasoning: number;
};

function toModelConfig(row: ModelRow): unknown {
  return {
    id: row.id,
    ...(row.name === null ? {} : { name: row.name }),
    api: row.api,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    reasoning: row.reasoning === 1,
  };
}

function parseAuthColumn(row: ProviderRow): unknown {
  try {
    return JSON.parse(row.auth);
  } catch {
    throw new Error(
      `Provider "${row.id}" has auth that is not JSON: ${row.auth}`,
    );
  }
}
