# MySQL MCP Tool Architecture

This document describes the overall architecture of the MySQL MCP service, the request call flow, module boundaries, connection pool lifecycle, configuration system, and error-code model. All terms, tool names, config names, defaults, and error codes are consistent with [Tool Contracts & Security Design](tool-contracts-and-security.md) and [Testing Matrix & Implementation Roadmap](testing-and-roadmap.md).

> **中文版**: 本文件的中文平行版见 [architecture.zh-CN.md](architecture.zh-CN.md)。

## 1. Overall Architecture

The MCP service runs as a subprocess of an AI client (such as Claude Desktop, Cursor, etc.) and exchanges JSON-RPC frames with the client over `stdio`. The service writes protocol data to `stdout` and redacted logs to `stderr`.

```
┌────────────────────────────┐        JSON-RPC over stdio
│        MCP Client          │ ◄─────────────────────────────►
└────────────────────────────┘
                              │  stdout: protocol frames / stderr: redacted logs
                              ▼
┌────────────────────────────────────────────────────────────┐
│                     MCP Server (mysql-mcp-tool)            │
│                                                            │
│  ┌──────────┐   ┌──────────┐   ┌────────────┐   ┌────────┐ │
│  │ main     │──►│ Server   │──►│ Tool       │──►│ Security│ │
│  │ (entry)  │   │ (MCP SDK)│   │ registry   │   │ policy │ │
│  └──────────┘   └──────────┘   └────────────┘   └────────┘ │
│                 └──────────┘         │                     │
│                          ┌───────────▼──────────┐         │
│                          │   Tool handlers (5)  │         │
│                          │ list_databases       │         │
│                          │ list_tables          │         │
│                          │ describe_table       │         │
│                          │ query                │         │
│                          │ execute (always reg) │         │
│                          └───────────┬──────────┘         │
│                                      │                    │
│              ┌───────────────────────┼─────────────┐      │
│              ▼                       ▼             ▼      │
│        ┌───────────┐          ┌────────────┐  ┌──────────┐│
│        │ Metadata  │          │ SQL parse/ │  │ Serialize││
│        │ service   │          │ classifier │  └──────────┘│
│        └─────┬─────┘          └────────────┘              │
│              ▼                                            │
│        ┌─────────────────────────────────────────────────┐│
│        │ ConnectionManager (lazy per-target multi pools) ││
│        └─────────────────────────┬───────────────────────┘│
│                                  ▼                        │
│                    ┌──────────────────────────┐           │
│                    │ MySQL pool (per-source    │           │
│                    │ mysql2)                   │           │
│                    └──────────────────────────┘           │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     MySQL server (low-privilege account)
```

## 2. Module Boundaries

| Module | Responsibility | Not responsible for |
| --- | --- | --- |
| **Entry `main`** | Parse environment and startup args, construct Server, bind stdio transport, register lifecycle hooks | Business logic, SQL validation |
| **Config `loadSourcesConfig`** | Read and validate multi-data-source config from JSON file (path from `MCP_SOURCES_FILE`), produce `SourcesConfig`; expand password env-var references | I/O, SQL execution |
| **Server** | Manage tool registration, request dispatch, initialization handshake via MCP TS SDK | SQL semantics judgment |
| **Tool registry** | Always register 5 tools (including `mysql_execute`); decide write availability inside runtime handlers per data-source `allowWrite` | Dynamically altering the tool set at runtime |
| **Connection management `ConnectionManager`** | Lazily create and reuse multiple per-source `MysqlPool` by target; resolve the target source, dispatch read/write executors by target; call `endAll` to converge all pools | SQL semantics judgment, serialization |
| **Connection pool `MysqlPool`** | Create/reuse/destroy a pool to a single merged data-source config; control concurrency cap | Connecting to multiple data sources, cross-source dispatch |
| **Metadata service** | Wrap informational queries needed by `list_databases` / `list_tables` / `describe_table` | Business queries |
| **SQL classifier** | Classify statements via AST parsing and check dangerous features (read-only vs write, allowed or not) | Actual execution |
| **Security policy** | Validate parameters, limit rows/timeouts/affected rows, denylist, write switches | SQL syntax parsing |
| **Serialization** | Convert MySQL row data to JSON, handling large numbers/dates/binary/`NULL` | Behavior beyond type detection |
| **Error mapping** | Map internal exceptions to stable error codes and redacted messages | Throwing raw exceptions directly |

## 3. Request Call Flow

The read-only query path using `mysql_query`:

```
Client ──(invoke mysql_query)──► Server ──► Security policy(param/timeout/rows validation)
        ──► SQL classifier(AST classify + dangerous features) ──► Policy decision(SELECT allowed)
        ──► Pool.getConnection ──► execute(parameterized) ──► serialize row data
        ──► Result(column metadata + rows + truncation flag + duration) ──► Server ──► Client
```

The controlled write path using `mysql_execute` (available when the target source's `allowWrite` is enabled):

```
Client ──(invoke mysql_execute)──► Server
        ──► target source allowWrite check(disabled→WRITE_DISABLED)
        ──► SQL classifier(AST classify) ──► Policy decision(only INSERT / UPDATE|DELETE with WHERE)
        ──► BEGIN ──► execute ──► affected rows ≤ limit? ├─ yes ──► COMMIT
                                                         └─ no  ──► ROLLBACK
        ──► Result(affected rows/ changed rows/ insert id/ duration) ──► Client
```

## 4. Connection Pool Lifecycle

- **Multiple data sources**: a single process can declare several MySQL data sources (distinguished by the target identifier). `ConnectionManager` **lazily creates and reuses** the `MysqlPool` for the corresponding source by target; pool parameters (`poolSize` / `poolIdleTimeoutMs`) come from the process-level `global` config, injected into all pools at construction.
- **Default source**: tool calls that do not specify a target fall back to `defaultTarget` (defaults to the first `source`); unknown targets return `PARAM`.
- **Lazy connection**: the pool for a target is created on first access; connectivity is not forcibly verified at startup (to avoid occupying idle resources); unaccessed data sources establish no connections. A failed first execution on a tool returns `CONNECTION`.
- **Pool parameters**: `poolSize` and `poolIdleTimeoutMs` are controlled by the `global` config; see the configuration system below.
- **Shutdown cleanup**: `SIGINT` / `SIGTERM` / `exit` / `uncaughtException` / `unhandledRejection` hooks are registered to call `ConnectionManager.endAll()` to iterate and gracefully close all data-source pools; the process exits after cleanup. Shutdown cleanup logs go to `stderr`.
- **Exception handling**: connection-acquisition failures, execution interruptions, and query timeouts are mapped to stable error codes; no implicit connection retry (the caller decides whether to retry).

## 5. Configuration System

Multiple data sources are declared in a **single JSON file**, whose path is specified by the environment variable `MCP_SOURCES_FILE` (default `./mcp.sources.json`). The service parses and validates the full configuration at startup (`loadSourcesConfig()`); any invalid item causes an immediate **fail-fast exit**. The flat `MYSQL_HOST`-style environment variables are no longer used as connection sources in v1 (only passwords support `${VAR}` references); the old flat env-var list is deprecated.

### 5.0 File Entry and target

- **File path**: `MCP_SOURCES_FILE`, default `./mcp.sources.json`.
- **`target` rules**: non-empty, 1–64 chars, charset of any Unicode letters/digits (including CJK characters such as Chinese) plus `_`/`-`, globally unique.
- **`defaultTarget`**: optional, declares the default target source (must point to an existing target); defaults to the first `source`. Tools that do not specify a target fall back to the default source.
- **Password env-var references**: the password field may be written as `${VAR}` (e.g. `${MYSQL_PASSWORD}`), expanded to the corresponding environment variable at startup; after expansion the plaintext is kept only in memory and **must never be written to any log**.

Example config file structure:

```json
{
  "global": { ... },
  "defaultTarget": "app",
  "sources": [ { "target": "app", ... }, ... ]
}
```

### 5.1 Types and Field Classification

- **`GlobalConfig`**: `poolSize` / `poolIdleTimeoutMs` / `logLevel` / `defaultTarget` (process-level global).
- **`DatasourceConfig`**: `target` + connection parameters + overridable control items (the former single-source `Config` type was renamed).
- **`SourcesConfig`**: `global` + `sources` array.

Fields are managed in the following three categories:

| Category | Fields | Placement constraint |
| --- | --- | --- |
| **Global-only** (only in `global`) | `poolSize`, `poolIdleTimeoutMs`, `logLevel` | fail-fast if placed in a source |
| **Overridable** (three-level merge source > global > built-in default) | `queryTimeoutMs`, `maxRows`, `maxAffectedRows`, `sqlMaxLength`, `maxParams`, `allowWrite`, `tls`, `tlsRejectUnauthorized`, `connectTimeoutMs` | allowed in both source and global |
| **Connection parameters** (required in source, not in `global`) | `host`, `port`, `user`, `password`, `database`, `charset`, `target` | only in a source; fail-fast if in `global` |

### 5.2 Connection Parameters (per source)

| Config item | Required | Default | Valid range/format | Startup-failure condition | Sensitivity | Allowed in logs |
| --- | --- | --- | --- | --- | --- | --- |
| `target` | Yes | None | non-empty, 1–64, Unicode letters/digits (incl. Chinese) + `_`/`-` | missing/empty/too long/invalid char/duplicate | Low | Yes |
| host `host` | Yes | None | non-empty string, DNS/IPv4/IPv6/hostname | missing or empty | Low | Yes |
| port `port` | No | `3306` | integer 1–65535 | non-integer or out of range | Low | Yes |
| username `user` | Yes | None | non-empty string | missing or empty | Medium | No |
| password `password` | Yes | None | any string, supports `${VAR}` reference | missing or empty / referenced var missing or empty | High | **No (forbidden in any log)** |
| database `database` | No | empty | non-empty string; when empty use the account default database | none | Medium | Yes |
| charset `charset` | No | `utf8mb4` | valid charset name | invalid charset | Low | Yes |

### 5.3 Overridable Control Items (global default + per-source override)

| Config item | Built-in default | Valid range/format | Startup-failure condition | Sensitivity | Allowed in logs |
| --- | --- | --- | --- | --- | --- |
| Connection timeout(ms) `connectTimeoutMs` | `10000` | integer 100–600000 | out of range | Low | Yes |
| Query timeout(ms) `queryTimeoutMs` | `30000` | integer 100–300000(see below) | out of range | Low | Yes |
| Max returned rows `maxRows` | `1000` | integer 1–10000 | out of range | Low | Yes |
| SQL max length `sqlMaxLength` | `16384` | integer 1–1048576 | out of range | Low | Yes |
| Max params count `maxParams` | `500` | integer 0–10000 | out of range | Low | Yes |
| Max affected rows `maxAffectedRows` | `1000` | integer 1–100000 | out of range | Low | Yes |
| TLS enabled `tls` | `false` | `true`/`false` | invalid value | Low | Yes |
| TLS reject unauthorized cert `tlsRejectUnauthorized` | `true` | `true`/`false` | invalid value | Low | Yes |
| Controlled write enabled `allowWrite` | `false` | `true`/`false` | invalid value | Medium | Yes |

### 5.4 Global-Only Fields

| Config item | Default | Valid range/format | Startup-failure condition |
| --- | --- | --- | --- |
| Pool size `poolSize` | `5` | integer 1–100 | out of range |
| Pool idle timeout(ms) `poolIdleTimeoutMs` | `60000` | integer 0–3600000; 0=disabled | out of range |
| Log level `logLevel` | `info` | `debug`/`info`/`warn`/`error`/`silent` | invalid value |

### 5.5 Merge Rules

Each source's final config = **source explicit value > global value > built-in default** (three-level merge). Connection parameters do not participate in merging and are required within a source.

**Generic config-validation rules**

- **Booleans accept only `true`/`false`** (case-insensitive, and JSON booleans are accepted); `1`, `0`, `yes`, `no`, `on`, `off` are all treated as invalid and rejected at startup.
- **Numeric values must be bounds-checked**; a parse failure (non-numeric) or out-of-range fails fast.
- All `*_MS` values are integer milliseconds, not floats.
- `queryTimeoutMs` upper bound is 300000 (5 min) to prevent misconfiguration; a single tool call may pass a smaller `timeoutMs`, but not exceeding that source's service cap; see the tool contracts.
- On invalid config, the service fails fast at startup; errors contain only the config item name, never the value (redacted).

> **Deprecation note**: the v1 flat environment-var list (`MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_PORT` / `MYSQL_DATABASE` / `MYSQL_ALLOW_WRITE`, etc.) is no longer used as a connection-parameter source and is deprecated. Only `MCP_SOURCES_FILE` remains as the config-file-path entry, with passwords passed in via `${VAR}` references.

## 6. Logging and Redaction

- **stderr only**: all logs go to `stderr`; `stdout` must never contain non-protocol content.
- **Redaction rules**: password fields in logs are always replaced with `********` (including plaintext expanded from `${VAR}` — after expansion it lives only in memory and must not enter any log); usernames may be logged; SQL text is logged only as the **classification result and the rejection reason for validation**, never the full SQL body (to avoid leaking table structure or sensitive queries).
- **Correlation ID**: each tool call is assigned an incrementing request ID of the form `req-<n>`, which appears consistently in logs and error responses for troubleshooting.
- Error responses return via `isError: true`; the `details` field keeps only redacted information; the raw exception stack goes only to logs, never to the client response.

## 7. Error-Code Model

| Error code | Name | Client message (redacted) | Retryable | Redacted details | Log correlation |
| --- | --- | --- | --- | --- | --- |
| `CONFIG_INVALID` | Invalid config | The server startup config is invalid | No | failing config item name (not value) | `req-<n>` |
| `CONNECTION` | Connection failed | Unable to connect to MySQL | Yes | none | `req-<n>` |
| `TIMEOUT` | Execution timeout | Query/write exceeded the time limit | Yes | actual/set timeout value | `req-<n>` |
| `PARAM` | Invalid parameter | Tool input does not match the Schema | No | field name and error summary | `req-<n>` |
| `POLICY_REJECTED` | Policy rejected | The operation is not within the allowed scope | No | rejection reason (classification/feature) | `req-<n>` |
| `WRITE_DISABLED` | Write disabled | Write capability is not enabled | No | none | `req-<n>` |
| `RESULT_LIMIT` | Result over limit | Returned/affected result exceeds the limit | No | the exceeded limit type and value | `req-<n>` |
| `SERIALIZE` | Serialization failed | Result could not be serialized | No | field name | `req-<n>` |
| `INTERNAL` | Internal error | Service internal error | No | none (logs contain the stack) | `req-<n>` |

All errors are returned via the MCP standard error response with `isError: true`; the client message is constant and localizable, and does not leak SQL bodies or credentials.

**Multi-data-source semantics**

- **Unknown target**: no new top-level error code is added (no `SOURCE_NOT_FOUND`); `PARAM` is reused, and `details` carries `target=...`.
- **Write source not enabled**: when a data source has `allowWrite=false`, calling `mysql_execute` reuses `WRITE_DISABLED` (client message "Write capability is not enabled").

## 8. Relationship to Other Documents

- Tool I/O schemas, the SQL decision table, and the permission matrix are in [Tool Contracts & Security Design](tool-contracts-and-security.md).
- Test cases and acceptance criteria for the above config and error codes are in [Testing Matrix & Implementation Roadmap](testing-and-roadmap.md).
- Capability boundaries and quick start are in the project [README](../README.md) (Chinese: [README.zh-CN.md](../README.zh-CN.md)).
