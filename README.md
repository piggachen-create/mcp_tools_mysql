# MySQL MCP Tool

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for MySQL. Through the MCP protocol, this service lets AI clients explore MySQL database structure and run read-only queries in a unified, controlled way; write capability is enabled explicitly per data source.

> **Current status: multi-data-source release (M4 milestone complete)**
> Configuration is declared in a single JSON file (`MCP_SOURCES_FILE`) for **multiple data sources** (`global` defaults merged with per-source `sources` overrides); `ConnectionManager` lazily creates and reuses per-target connection pools; all 5 tools are always registered, and `mysql_execute` availability is decided by the target data source's `allowWrite`. Typecheck and the full unit-test suite pass.

> **中文版**: 英文为主，中文平行版见 [README.zh-CN.md](README.zh-CN.md)；设计文档见 [docs/](docs/)（英文）与 `docs/*.zh-CN.md`（中文）。

---

## Table of Contents

1. [Overview](#1-overview)
2. [Requirements & Build](#2-requirements--build)
3. [Quick Start](#3-quick-start)
4. [Configuration Reference](#4-configuration-reference)
5. [Using the Tools (Manual)](#5-using-the-tools-manual)
6. [Error Handling](#6-error-handling)
7. [Security Model](#7-security-model)
8. [Troubleshooting](#8-troubleshooting)
9. [Packaging & Publishing](#9-packaging--publishing)
10. [Documentation](#10-documentation)

---

## 1. Overview

### 1.1 What it does

- Provides AI clients with MySQL **metadata reads** (databases / tables / column schemas) and **controlled multi-data-source queries** through MCP tools.
- Each data source can independently enable **limited writes**; everything is read-only by default.

### 1.2 Tech stack

- Node.js + TypeScript, the official MCP TypeScript SDK, `mysql2/promise` driver.
- **Transport**: v1 supports only the `stdio` transport; no HTTP/SSE, multi-tenancy, or admin UI.

### 1.3 Multi-data-source & per-source switches

- A single process declares several MySQL data sources in `mcp.sources.json`, each identified by a `target`.
- Write capability is controlled **per data source** via `allowWrite`. Calling `mysql_execute` on a source where writes are disabled returns `WRITE_DISABLED`.

### 1.4 Security boundary

- SQL application-layer policy is the first line of defense-in-depth; **MySQL account permissions are the ultimate security boundary**. The service must run with a low-privilege database account.

### 1.5 Available tools

| Tool | Description | Registered by default |
| --- | --- | --- |
| `mysql_list_databases` | List databases visible to the account of the specified data source (default source if omitted) | ✅ |
| `mysql_list_tables` | List tables and views under a given schema | ✅ |
| `mysql_describe_table` | Describe the column structure of a single table/view | ✅ |
| `mysql_query` | Run a read-only query (parameterized, row-limited, timeout-limited) | ✅ |
| `mysql_execute` | Run controlled DML in a transaction (only `INSERT`, and `UPDATE`/`DELETE` with a `WHERE`); gated by the target source's `allowWrite` | ✅ |

All tools accept an optional `target` field: it selects a data source, defaulting to the default source (`defaultTarget`, which falls back to the first `source` when unset).

### 1.6 Non-goals (explicitly out of scope for v1)

- DDL / DCL / TCL: `CREATE` / `ALTER` / `DROP` / `GRANT` / `BEGIN` / `COMMIT` are all rejected.
- Stored procedure / function calls (`CALL`), multi-statement batches.
- Arbitrary database switching, transaction session management, or free cross-database queries after a session-level `USE`.
- HTTP/SSE, multi-tenancy, web admin UI, or an authentication framework.
- Dynamically enabling/disabling write capability at runtime via MCP requests.

## 2. Requirements & Build

### 2.1 Requirements

- **Node.js ≥ 20** (see `package.json` → `engines`).

### 2.2 Build and test

```bash
npm install        # install dependencies
npm run typecheck  # type check only (tsc --noEmit)
npm test           # run the unit test suite (vitest)
npm run build      # clean + compile to dist/
npm start          # run dist/index.js (stdio mode)
```

## 3. Quick Start

### Step 1 — Prepare low-privilege database accounts

The service must run with a low-privilege account (database permissions are the ultimate security boundary):

- **Read-only data source** (`allowWrite=false`): run [examples/grant-ro.sql](examples/grant-ro.sql)
- **Write data source** (corresponding to `allowWrite=true`): run [examples/grant-rw.sql](examples/grant-rw.sql)

### Step 2 — Write the multi-data-source config (`mcp.sources.json`)

Configuration is declared in a single JSON file, whose path is set by the environment variable `MCP_SOURCES_FILE` (default `./mcp.sources.json`). Top-level structure: `{ global?, defaultTarget?, sources: [...] }`.

A minimal single-source config:

```json
{
  "sources": [
    {
      "target": "app",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "mysql_mcp_ro",
      "password": "${MYSQL_PASSWORD}",
      "database": "app"
    }
  ]
}
```

A full multi-source example (global defaults + per-source overrides + a writable source):

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

### Step 3 — Connect an MCP client (stdio)

Launch the service as a subprocess and point it to a config file via `MCP_SOURCES_FILE`. Example for Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

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

> **About `target`**: every tool accepts an optional `target` field to select a data source, defaulting to `defaultTarget` (`app` in the example). For example, `"target": "write-pool"` runs controlled DML against that writable source.

## 4. Configuration Reference

### 4.1 Environment variables

| Environment variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MCP_SOURCES_FILE` | No | `./mcp.sources.json` | Path to the multi-data-source JSON config file |

### 4.2 Field placement

| Category | Fields | Placement constraint |
| --- | --- | --- |
| **Global-only** | `poolSize`, `poolIdleTimeoutMs`, `logLevel` | only in `global`; placing in a `source` fails fast |
| **Overridable** (three-level merge: **source > global > built-in default**) | `queryTimeoutMs`, `maxRows`, `maxAffectedRows`, `sqlMaxLength`, `maxParams`, `allowWrite`, `tls`, `tlsRejectUnauthorized`, `connectTimeoutMs` | allowed in both `global` and `source` |
| **Connection parameters** (per-source required) | `target`, `host`, `user`, `password`, (`port`, `database`, `charset`) | only in a `source`; appearing in `global` fails fast |

### 4.3 Defaults and ranges

| Config item | Built-in default | Valid range / format |
| --- | --- | --- |
| `poolSize` (global-only) | `5` | integer 1–100 |
| `poolIdleTimeoutMs` (global-only) | `60000` | integer 0–3600000; 0 = disabled |
| `logLevel` (global-only) | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `connectTimeoutMs` | `10000` | integer 100–600000 |
| `queryTimeoutMs` | `30000` | integer 100–300000 |
| `maxRows` | `1000` | integer 1–10000 |
| `sqlMaxLength` | `16384` | integer 1–1048576 |
| `maxParams` | `500` | integer 0–10000 |
| `maxAffectedRows` | `1000` | integer 1–100000 |
| `tls` | `false` | `true`/`false` |
| `tlsRejectUnauthorized` | `true` | `true`/`false` |
| `allowWrite` | `false` | `true`/`false` |
| `port` (per source) | `3306` | integer 1–65535 |
| `charset` (per source) | `utf8mb4` | valid charset name |

### 4.4 Validation rules

- Booleans accept only `true`/`false` (case-insensitive); `1`, `0`, `yes`, `no`, `on`, `off` are rejected.
- Numeric values are bounds-checked; anything non-numeric or out of range fails fast.
- `"target"` must be non-empty, 1–64 chars, charset `[a-zA-Z0-9_-]`, globally unique.
- `defaultTarget` must point to an existing `target`; it falls back to the first `source` when unset.
- Config errors fail fast at startup; the message contains only the config item name, **never the value** (redacted).

### 4.5 Passwords and secrets

- The `password` field supports `${VAR}` references (e.g. `${MYSQL_PASSWORD}`), expanded from environment variables at startup.
- After expansion the plaintext lives **only in memory** and **must never be written to any log**.
- Credentials are never accepted as MCP tool arguments.

See [Architecture · Configuration System](docs/architecture.md#5-configuration-system) for the full details.

## 5. Using the Tools (Manual)

All tool outputs are returned as JSON strings. Execution-semantics errors are returned with `isError: true` plus a stable `code`, a constant redacted `message`, and (when relevant) a `details` field.

### 5.1 `mysql_list_databases` — list visible databases

```json
{ "target": "app" }
```

Output:

```json
{ "databases": ["information_schema", "app", "analytics"], "truncated": false }
```

### 5.2 `mysql_list_tables` — list tables/views in a schema

```json
{ "target": "app", "schema": "app" }
```

Output:

```json
{ "schema": "app", "tables": ["users", "orders", "v_active_users"], "truncated": false }
```

### 5.3 `mysql_describe_table` — inspect column structure

```json
{ "target": "app", "table": "users", "schema": "app" }
```

Output:

```json
{
  "schema": "app",
  "table": "users",
  "columns": [
    {
      "name": "id",
      "type": "bigint",
      "nullable": false,
      "key": "PRI",
      "default": null,
      "extra": "auto_increment"
    }
  ]
}
```

> `schema` is optional; when omitted the tool uses the data source's configured default `database`. If neither is set, `PARAM` is returned.

### 5.4 `mysql_query` — read-only query

Use `?` placeholders and pass values in `params` (never concatenate input into SQL).

```json
{
  "target": "app",
  "sql": "SELECT id, name, balance FROM users WHERE status = ? ORDER BY id LIMIT 5",
  "params": [1],
  "maxRows": 100,
  "timeoutMs": 5000
}
```

Output:

```json
{
  "columns": ["id", "name", "balance"],
  "rows": [
    ["1", "alice", "1234.56"],
    ["2", "bob", "7.89"]
  ],
  "columnTypes": ["bigint", "varchar", "decimal"],
  "rowCount": 2,
  "truncated": false,
  "durationMs": 12
}
```

Notes:

- `SELECT` / `SHOW` / `EXPLAIN` (allowed subset) only; anything else is rejected with `POLICY_REJECTED`.
- **Large numeric values** (`BIGINT`, `DECIMAL`) are returned as **strings** to avoid precision loss.
- If results exceed `maxRows`, only the first `maxRows` rows are returned with `truncated: true` (this is **not** an error).
- `maxRows` and `timeoutMs` are optional and capped by the target source's settings.

### 5.5 `mysql_execute` — controlled write

Only available on sources with `allowWrite: true`; otherwise returns `WRITE_DISABLED`. Executes **in a transaction** — if affected rows exceed the source's cap, it rolls back.

```json
{
  "target": "write-pool",
  "sql": "UPDATE users SET balance = ? WHERE id = ?",
  "params": [100.00, 42]
}
```

Output:

```json
{ "affectedRows": 1, "changedRows": 1, "insertId": 0, "durationMs": 8 }
```

**Allowed write forms** (only these):

| Form | Allowed |
| --- | --- |
| `INSERT INTO t (cols) VALUES (...)` (incl. multi-value) | ✅ |
| `UPDATE t SET ... WHERE ...` (must have non-empty `WHERE`) | ✅ |
| `DELETE FROM t WHERE ...` (must have non-empty `WHERE`) | ✅ |
| Unconditional `UPDATE`/`DELETE`, `INSERT ... SELECT`, `REPLACE`, upsert (`ON DUPLICATE KEY UPDATE`), multi-table writes, DDL/DCL/TCL/`CALL` | ⛔ rejected |

## 6. Error Handling

All errors return `isError: true` with `{ "code", "message", "details"? }`. The `message` is constant and redacted (never leaks SQL bodies or credentials); the raw stack is written only to `stderr` logs with a `req-<n>` correlation id.

| Error code | Meaning | Typical cause | Handling |
| --- | --- | --- | --- |
| `CONFIG_INVALID` | Invalid startup config | a config field is missing/invalid/CJK-target mismatch | Fix the config; fail-fast occurs at startup (message names the item only) |
| `CONNECTION` | Cannot connect to MySQL | wrong host/port, credentials, network, or account lacks access | Verify connectivity and the low-privilege account |
| `TIMEOUT` | Query/write exceeded the time limit | a query longer than `queryTimeoutMs` | Retry, or raise the source's `queryTimeoutMs` |
| `PARAM` | Tool input does not match the Schema | unknown target, over-length SQL/params, placeholder/param count mismatch, out-of-range `maxRows`/`timeoutMs` | Fix the input per the tool schema |
| `POLICY_REJECTED` | Operation outside the allowed scope | SQL not in the read/write whitelist | Check `details` for the rejection reason |
| `WRITE_DISABLED` | Write capability not enabled | calling `mysql_execute` on an `allowWrite=false` source | Enable `allowWrite` on that source, or use a read-only flow |
| `RESULT_LIMIT` | Result/affected rows exceed the limit | write affected rows > `maxAffectedRows` (transaction rolled back) | Narrow the statement (e.g. add/refine `WHERE`) |
| `SERIALIZE` | Result could not be serialized | unsupported column value | Contact maintainers; treat as data issue |
| `INTERNAL` | Internal error | unexpected exception | Check `stderr` logs; report with the `req-<n>` id |

## 7. Security Model

1. **Strict `stdout` / `stderr` separation**: `stdout` carries only MCP protocol frames; all logs go to `stderr` with sensitive data redacted.
2. **Parameterized queries**: `params` always use prepared binding; caller input is never concatenated into SQL.
3. **Credentials never passed as tool arguments** — server config only.
4. **Transactional writes** with affected-row-cap rollback (no partial commits).
5. **Exact numeric preservation** (`BIGINT`/`DECIMAL` as strings).
6. **Defense in depth**: application-layer SQL policy is the first line; **MySQL account permissions are the final boundary**. Use low-privilege accounts (see [examples/grant-ro.sql](examples/grant-ro.sql) / [examples/grant-rw.sql](examples/grant-rw.sql)).

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Service exits at startup | Config fails fast | Check the printed config-item name; ensure booleans are `true`/`false`, numbers in range, `target` unique and `[a-zA-Z0-9_-]`; ensure connection params are in `source`, global-only fields in `global` |
| Tool returns `WRITE_DISABLED` | Source has `allowWrite=false` | Set `allowWrite: true` for that source (per-source), or use read-only tools |
| `CONNECTION` on first use | Unreachable host or bad credentials | Verify the account/permissions and network; remember pools are created lazily on first access |
| `POLICY_REJECTED` unexpectedly | SQL not in the whitelist | Review the allowed forms (Section 5.5) and the decision table in [Tool Contracts](docs/tool-contracts-and-security.md) |
| Query truncated | Result > source `maxRows` | Pass a larger `maxRows` (up to the source cap) or raise the cap |
| Large numbers look wrong | Not applicable if kept as strings | Confirm you receive `BIGINT`/`DECIMAL` as JSON strings |
| Write unexpectedly rolls back | Affected rows > `maxAffectedRows` | Refine the `WHERE` / raise the cap |

## 9. Packaging & Publishing

```bash
npm pack   # prepack auto-cleans + builds; the tarball contains only dist/docs/examples
```

`private: true` prevents accidental publishing to the npm registry; to publish publicly, remove the flag and add a license first.

## 10. Documentation

- [Architecture & Call Flow](docs/architecture.md) — request path, module boundaries, configuration system, error-code model.
- [Tool Contracts & Security Design](docs/tool-contracts-and-security.md) — I/O schemas for the 5 tools, SQL policy decision table, database permission matrix, serialization semantics.
- [Testing Matrix & Implementation Roadmap](docs/testing-and-roadmap.md) — unit/integration/security regression test matrix, plus M0–M4 phase goals and exit criteria.

Chinese: 设计文档见 `docs/*.zh-CN.md`；本手册中文版见 [README.zh-CN.md](README.zh-CN.md)。

Recommended reading order: Architecture & Configuration → Tool Contracts & Security → Testing & Roadmap.

---

## License

To be determined (to be added before publishing to a public registry).
