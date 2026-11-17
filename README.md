# MySQL MCP Tool

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for MySQL. Through the MCP protocol, this service lets AI clients explore MySQL database structure and run read-only queries in a unified, controlled way; write capability is enabled explicitly per data source.

> **Current status: multi-data-source release (M4 milestone complete)**
> Configuration is declared in a single JSON file (`MCP_SOURCES_FILE`) for **multiple data sources** (`global` defaults merged with per-source `sources` overrides); `ConnectionManager` lazily creates and reuses per-target connection pools; all 5 tools are always registered, and `mysql_execute` availability is decided by the target data source's `allowWrite`. Typecheck and the full unit-test suite (249/249) pass.

## Project Positioning

- **Capabilities**: provides AI clients with MySQL metadata reads (databases/tables/schemas) and controlled multi-data-source queries through MCP tools; each data source can independently enable limited writes.
- **Tech stack**: Node.js + TypeScript, official MCP TypeScript SDK, `mysql2/promise` driver.
- **Transport**: v1 supports only the `stdio` transport; no HTTP/SSE, multi-tenancy, or admin UI.
- **Multiple data sources with per-source switches**: a single process declares several data sources via `mcp.sources.json` (each identified by `target`); write capability is controlled per data source via `allowWrite`. Calling `mysql_execute` on a source where writes are disabled returns `WRITE_DISABLED`.
- **Security boundary**: SQL application-layer policy is the first line of defense-in-depth; **MySQL account permissions are the ultimate security boundary**. The service must run with a low-privilege database account.

## v1 Capabilities

| Tool | Description | Registered by default |
| --- | --- | --- |
| `mysql_list_databases` | List databases visible to the account of the specified data source (default source if omitted) | ✅ |
| `mysql_list_tables` | List tables and views under a given schema | ✅ |
| `mysql_describe_table` | Describe the column structure of a single table/view | ✅ |
| `mysql_query` | Run a read-only query (parameterized, row-limited, timeout-limited) | ✅ |
| `mysql_execute` | Run controlled DML in a transaction (only `INSERT`, and `UPDATE`/`DELETE` with a `WHERE`); gated by the target source's `allowWrite` | ✅ |

All tools accept an optional `target` field: it selects a data source, defaulting to the default source (`defaultTarget`, which falls back to the first `source` when unset).

## Non-Goals (explicitly out of scope for v1)

- DDL / DCL / TCL: `CREATE` / `ALTER` / `DROP` / `GRANT` / `BEGIN` / `COMMIT` are all rejected.
- Stored procedure / function calls (`CALL`), multi-statement batches.
- Arbitrary database switching, transaction session management, or free cross-database queries after a session-level `USE`.
- HTTP/SSE, multi-tenancy, web admin UI, or an authentication framework.
- Dynamically enabling/disabling write capability at runtime via MCP requests.

## Core Design Constraints

1. **Strict stdout / stderr separation**: `stdout` carries only MCP protocol frames; all logging and diagnostics go to `stderr`, with sensitive information redacted.
2. **Parameterized queries**: `params` of `mysql_query` / `mysql_execute` must use prepared parameter binding; caller input is never concatenated into SQL text.
3. **Credentials never passed as tool arguments**: database account, password, connection address, etc. are provided only by the server configuration; callers cannot pass or alter them through tool parameters.
4. **Transactional writes**: `mysql_execute` runs within a transaction; if affected rows exceed the limit, it rolls back — no partial commits.
5. **Exact numeric preservation**: large values such as `BIGINT` and `DECIMAL` are returned as strings to avoid precision loss.

## Documentation Navigation

- [Architecture & Call Flow](docs/architecture.md) — request path, module boundaries, configuration system, error-code model.
- [Tool Contracts & Security Design](docs/tool-contracts-and-security.md) — I/O schemas for the 5 tools, SQL policy decision table, database permission matrix, serialization semantics.
- [Testing Matrix & Implementation Roadmap](docs/testing-and-roadmap.md) — unit/integration/security regression test matrix, plus M0–M4 phase goals and exit criteria.

Reading order is recommended as above: first understand the overall architecture and configuration, then verify tool contracts and security policy, and finally review the acceptance criteria and roadmap.

> **中文文档**: 中英文字版见 [README.zh-CN.md](README.zh-CN.md)，文档位于 [docs/](docs/)（英文）与 `docs/*.zh-CN.md`（中文）。

## Quick Start

### 1. Build and Test

```bash
npm install        # install dependencies
npm run build      # compile to dist/ (typecheck + unit tests: npm run typecheck / npm test)
```

### 2. Prepare Low-Privilege Database Accounts

The service must run with a low-privilege account (database permissions are the ultimate security boundary):

- Read-only data source (`allowWrite=false`): run [examples/grant-ro.sql](examples/grant-ro.sql)
- Write data source (corresponding to `allowWrite=true`): run [examples/grant-rw.sql](examples/grant-rw.sql)

### 3. Write the Multi-Data-Source Config (mcp.sources.json)

Configuration is declared in a single JSON file, whose path is set by the environment variable `MCP_SOURCES_FILE` (default `./mcp.sources.json`). Top-level structure: `{ global?, defaultTarget?, sources: [...] }`.

See the multi-source example in [examples/mcp.sources.json](examples/mcp.sources.json):

```json
{
  "global": {
    "poolSize": 5,
    "poolIdleTimeoutMs": 60000,
    "queryTimeoutMs": 30000,
    "maxRows": 1000,
    "sqlMaxLength": 16384,
    "maxParams": 500,
    "maxAffectedRows": 1000,
    "tls": false,
    "tlsRejectUnauthorized": true,
    "allowWrite": false,
    "logLevel": "info"
  },
  "defaultTarget": "app",
  "sources": [
    {
      "target": "app",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "mysql_mcp_ro",
      "password": "${MYSQL_PASSWORD}",
      "database": "app"
    },
    {
      "target": "replica",
      "host": "replica.internal",
      "user": "mysql_mcp_ro",
      "password": "${MYSQL_REPLICA_PASSWORD}",
      "database": "analytics",
      "maxRows": 2000,
      "queryTimeoutMs": 20000
    },
    {
      "target": "write-pool",
      "host": "127.0.0.1",
      "user": "mysql_mcp_rw",
      "password": "${MYSQL_WRITE_PASSWORD}",
      "database": "app",
      "allowWrite": true,
      "maxAffectedRows": 500
    }
  ]
}
```

**Configuration notes**

- **Environment variables**:

| Environment variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MCP_SOURCES_FILE` | No | `./mcp.sources.json` | Path to the multi-data-source JSON config file |

- **Connection parameters** (required in each `source`, must NOT go in `global`): `target`, `host`, `user`, `password`; optional `port` (3306), `database`, `charset` (utf8mb4).
- **Global-only fields** (only in `global`): `poolSize` (5), `poolIdleTimeoutMs` (60000), `logLevel` (info).
- **Overridable fields** (three-level merge: source > global > built-in default): `queryTimeoutMs` (30000), `maxRows` (1000), `maxAffectedRows` (1000), `sqlMaxLength` (16384), `maxParams` (500), `allowWrite` (false), `tls` (false), `tlsRejectUnauthorized` (true), `connectTimeoutMs` (10000).
- **`target` rules**: non-empty, 1–64 chars, charset `[a-zA-Z0-9_-]`, globally unique; `defaultTarget` falls back to the first `source` when unset.
- **Password `${VAR}` references**: the password field supports `${MYSQL_PASSWORD}`-style references to environment variables, expanded at startup; the plaintext is kept only in memory and **must never be written to any log**.
- On invalid config, the service fails fast at startup; errors contain only the config item name, never the value.

See [Architecture · Configuration System](docs/architecture.md#5-configuration-system) for the full list of config items.

### 4. Connect an MCP Client (stdio)

Using Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`) as examples, launch the service as a subprocess and point it to a config file via `MCP_SOURCES_FILE`:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["/absolute/path/to/mysql-mcp-tool/dist/index.js"],
      "env": {
        "MCP_SOURCES_FILE": "/absolute/path/to/mysql-mcp-tool/examples/mcp.sources.json",
        "MYSQL_PASSWORD": "<strong password>",
        "MYSQL_REPLICA_PASSWORD": "<replica strong password>",
        "MYSQL_WRITE_PASSWORD": "<write-account strong password>"
      }
    }
  }
}
```

- **About `target`**: each data source in the config is identified by `target`; pass the optional `target` field to any tool to select the target source, defaulting to `defaultTarget` (`app` in the example). For example, `"target": "write-pool"` runs controlled DML against that writable source.
- Write availability is decided by the **target source's** `allowWrite`: calling `mysql_execute` on a source with writes disabled (e.g. `app`) returns `WRITE_DISABLED`.
- On any invalid config item, the service fails fast at startup; errors contain only the config item name, never the value.

### 5. Packaging

```bash
npm pack   # prepack auto-cleans + builds; the tarball contains only dist/docs/examples
```

`private: true` prevents accidental publishing to the npm registry; to publish publicly, remove the flag and add a license first.

## License

To be determined (to be added before publishing to a public registry).

---

## Documentation Task Checklist

- [x] Repository initialization (Gitee private empty repo, `main` default branch)
- [x] M0 design freeze: four design documents reviewed and approved
- [x] M1 protocol skeleton & config parsing
- [x] M2 read-only capabilities (metadata + query + serialization + error mapping + multi-source target dispatch)
- [x] M3 controlled writes (always registered + per-source `allowWrite` gating + transactional DML)
- [x] M4 release preparation (packaging, README quick start, final docs)
- [x] Bilingual docs: English default + Chinese parallel files (`.zh-CN`)
