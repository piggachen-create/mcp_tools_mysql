# MySQL MCP Tool — Tool Contracts & Security Design

This document defines the input/output schemas of the 5 MCP tools, the SQL policy decision table, the database account permission matrix, JSON serialization semantics, and security-boundary conventions. All content is consistent with [Architecture](architecture.md) and [Testing Matrix & Implementation Roadmap](testing-and-roadmap.md).

> **中文版**: 本文件的中文平行版见 [tool-contracts-and-security.zh-CN.md](tool-contracts-and-security.zh-CN.md)。

## 1. Tool Overview

| Tool | Input | Output | Registered by default |
| --- | --- | --- | --- |
| `mysql_list_databases` | `target`(optional) | list of database names | ✅ |
| `mysql_list_tables` | `target`(optional), `schema`(required) | list of table/view names | ✅ |
| `mysql_describe_table` | `target`(optional), `table`(required), `schema`(optional) | column structure | ✅ |
| `mysql_query` | `target`(optional), `sql`, `params`, `maxRows`, `timeoutMs` | column metadata + rows + flags | ✅ |
| `mysql_execute` | `target`(optional), `sql`, `params` | affected/changed rows, insert id, duration | ✅ always registered (availability gated by per-source `allowWrite`) |

All tool outputs are returned as JSON strings in the MCP `content[].text`; execution-semantics errors are returned via `isError: true` + redacted messages.

**Common conventions**

- **`target` (optional on all tools)**: selects a data source; constraint is 1–64 chars, charset of any Unicode letters/digits (incl. CJK characters such as Chinese) plus `_`/`-`. When omitted it falls back to the server-side `defaultTarget` (defaults to the first `source`); unknown targets return `PARAM` (`details.target=...`).
- Unknown/extra fields: rejected by default (`additionalProperties: false`) to prevent callers from injecting unexpected fields.
- All string fields are length-capped (constrained by server-side limits such as the source's `sqlMaxLength`).
- Callers must not pass connection credentials, target connection strings, out-of-range `maxRows`, or operations other than expected `SELECT`.

## 2. Read-Only Metadata Tools

### 2.1 `mysql_list_databases`

Input schema: optional `target` (selects data source; defaults to the default source).

Output:

```json
{
  "databases": ["information_schema", "app", "analytics"],
  "truncated": false
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `databases` | string[] | Yes | database names visible to the account |
| `truncated` | boolean | Yes | whether the result was truncated due to count limit |

Empty result: `{"databases": [], "truncated": false}`.

### 2.2 `mysql_list_tables`

Input:

```json
{
  "target": "app",
  "schema": "app"
}
```

| Field | Type | Required | Default | Constraint |
| --- | --- | --- | --- | --- |
| `target` | string | No | default source | 1–64 chars, Unicode letters/digits (incl. Chinese) + `_`/`-`; select data source |
| `schema` | string | Yes | none | 1–128 chars, valid identifier charset `[a-zA-Z0-9_$]` |

Result row count is limited by the source's `maxRows`; on overflow it is truncated with `truncated: true`.

Output:

```json
{
  "schema": "app",
  "tables": ["users", "orders", "v_active_users"],
  "truncated": false
}
```

Empty result: `{"schema":"app","tables":[],"truncated":false}`.

### 2.3 `mysql_describe_table`

Input:

```json
{
  "target": "app",
  "table": "users",
  "schema": "app"
}
```

| Field | Type | Required | Default | Constraint |
| --- | --- | --- | --- | --- |
| `target` | string | No | default source | 1–64 chars, Unicode letters/digits (incl. Chinese) + `_`/`-`; select data source |
| `table` | string | Yes | none | 1–128 valid identifier chars |
| `schema` | string | No | the source's default database | if present, 1–128 valid identifier chars; otherwise the data source's `database` field is used |

> **Note**: the schema-default semantics resolve against the **target data source's** default database (`DatasourceConfig.database`); if that source has no default database configured and `schema` is not passed explicitly, `PARAM` is returned.

Output (column structure taken from `information_schema.COLUMNS` or `SHOW COLUMNS`):

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

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | column name |
| `type` | string | Yes | column type (e.g. `bigint`, `varchar`) |
| `nullable` | boolean | Yes | whether NULL is allowed |
| `key` | string | Yes | key type: `PRI`/`UNI`/`MUL`/`""` |
| `default` | string or null | Yes | default value |
| `extra` | string | Yes | extension (e.g. `auto_increment`) |

Empty result: `{"schema":"app","table":"users","columns":[]}` (a nonexistent table returns a `PARAM`-class error).

## 3. `mysql_query` (Read-Only Query)

### 3.1 Input

```json
{
  "target": "app",
  "sql": "SELECT id, name, balance FROM users WHERE status = ?",
  "params": [1],
  "maxRows": 100,
  "timeoutMs": 5000
}
```

| Field | Type | Required | Default | Constraint |
| --- | --- | --- | --- | --- |
| `target` | string | No | default source | 1–64 chars, Unicode letters/digits (incl. Chinese) + `_`/`-`; select data source |
| `sql` | string | Yes | none | length ≤ the source's `sqlMaxLength` (default 16384); non-empty after trimming |
| `params` | array | No | `[]` | element count ≤ the source's `maxParams` (default 500); elements must be scalar |
| `maxRows` | int | No | source's `maxRows`(1000) | 1–source's `maxRows`, and ≤ the source service cap |
| `timeoutMs` | int | No | source's `queryTimeoutMs`(30000) | 100–source's `queryTimeoutMs` (≤ source cap) |

**Input-validation failure** returns the `PARAM` error code (redacted `details` indicates the field).

**Two-layer validation**: at registration, the schema uses global defaults (the merged `global` value, used for the `tools/list` display-order cap); at runtime, handlers re-validate `sqlMaxLength` / `maxParams` / `maxRows` / `queryTimeoutMs` against the **target data source's** merged config, returning `PARAM` on overflow (details carry the source cap value).

### 3.2 Execution Constraints

- **Only read-only statements allowed**: released only when the SQL classifier determines the statement is read-only (allowed subset of `SELECT` / `SHOW` / `EXPLAIN` etc.); see the decision table in Section 6.
- **Parameterized**: `params` is bound via prepared placeholders (`?`), never concatenated into SQL.
- **Forbidden**: multi-statements, locking reads (`FOR UPDATE`/`LOCK IN SHARE MODE`), `INTO OUTFILE`, `CALL`, user-variable side effects, cross-statement state, etc.; see Section 6.
- **Read-only account**: the underlying account is read-only, so even if the application layer wrongly allows a statement, database permissions still reject it.

### 3.3 Output

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

| Field | Type | Description |
| --- | --- | --- |
| `columns` | string[] | column names (in result-set order) |
| `columnTypes` | string[] | MySQL type name of each column |
| `rows` | array of arrays | row data; each row is as long as `columns`; values are serialized JSON scalars or `null` |
| `rowCount` | int | actual returned row count |
| `truncated` | boolean | whether truncated by `maxRows` (true means more rows remain unreturned) |
| `durationMs` | int | server-side duration of this query (ms) |

**Empty result**: `{"columns":[],"rows":[],"columnTypes":[],"rowCount":0,"truncated":false,"durationMs":1}`.

**Over-limit handling**: when query results exceed `maxRows`, only the first `maxRows` rows are returned with `truncated: true`; this is not an error. Actual errors are thrown only for statements disallowed by [Section 6](#6-sql-policy-decision-table) (returning `POLICY_REJECTED`).

### 3.4 Examples

A successful example (parameterized, row-limited, timeout):

```json
{
  "sql": "SELECT id, name, balance FROM users WHERE status = ? ORDER BY id LIMIT 5",
  "params": [1],
  "maxRows": 100,
  "timeoutMs": 5000
}
```

Rejection examples (`POLICY_REJECTED`):

```text
// Input: multiple statements
{ "sql": "SELECT 1; DROP TABLE users" }
// Input: locking read
{ "sql": "SELECT * FROM users WHERE id = 1 FOR UPDATE" }
// Input: file output
{ "sql": "SELECT * INTO OUTFILE '/tmp/x.csv' FROM users" }
```

## 4. `mysql_execute` (Controlled Write)

**Always registered + per-source gating**: this tool **always appears in the tool list** (no longer depends on a global switch to decide registration). At runtime, its handler checks the **target data source's** `allowWrite`: when that source has writes disabled (source or `global` `allowWrite=false`), it returns `WRITE_DISABLED`. Write availability can be controlled per data source and cannot be turned on via MCP requests at runtime.

### 4.1 Input

```json
{
  "target": "write-pool",
  "sql": "UPDATE users SET balance = ? WHERE id = ?",
  "params": [100.00, 42]
}
```

| Field | Type | Required | Default | Constraint |
| --- | --- | --- | --- | --- |
| `target` | string | No | default source | 1–64 chars, Unicode letters/digits (incl. Chinese) + `_`/`-`; select data source. Returns `WRITE_DISABLED` if the source's `allowWrite=false` |
| `sql` | string | Yes | none | length ≤ the source's `sqlMaxLength` |
| `params` | array | No | `[]` | element count ≤ the source's `maxParams`; scalars only |

### 4.2 Allowed Write Forms

| Form | Allowed | Example |
| --- | --- | --- |
| `INSERT INTO t (cols) VALUES (...)` | ✅ | `INSERT INTO users (name) VALUES (?)` |
| `INSERT INTO t (cols) VALUES (...),(...)` multi-value | ✅ | batch multi-value insert |
| `UPDATE t SET ... WHERE ...` | ✅ | **must have a non-empty `WHERE`** |
| `DELETE FROM t WHERE ...` | ✅ | **must have a non-empty `WHERE`** |
| Unconditional `UPDATE` / `DELETE` | ⛔ | `UPDATE users SET x=1` |
| `INSERT ... SELECT` | ⛔ | `INSERT INTO a SELECT * FROM b` |
| `REPLACE` / upsert (`ON DUPLICATE KEY UPDATE`) | ⛔ | `REPLACE INTO ...` / `INSERT ... ON DUPLICATE KEY UPDATE ...` |
| Multi-table writes | ⛔ | `UPDATE a JOIN b ...` / `DELETE a FROM a JOIN b ...` |
| DDL / DCL / TCL / `CALL` | ⛔ | see Section 6 |

### 4.3 Transactional Execution

1. Validate the target source's `allowWrite` (disabled → `WRITE_DISABLED`)
2. `BEGIN`
3. Execute the parameterized statement
4. Read affected row count (`affectedRows`)
5. If `affectedRows > the source's maxAffectedRows` (default 1000) → `ROLLBACK`, return `RESULT_LIMIT`
6. Otherwise `COMMIT`

`maxAffectedRows` and `queryTimeoutMs` are both taken from the **target data source's** merged config. Any exception → `ROLLBACK`, returning the corresponding error code (connection/timeout/policy, etc.). **No partial commits, ever**.

### 4.4 Output

```json
{
  "affectedRows": 1,
  "changedRows": 1,
  "insertId": 0,
  "durationMs": 8
}
```

| Field | Type | Description |
| --- | --- | --- |
| `affectedRows` | int | affected rows (`INSERT` is the inserted count) |
| `changedRows` | int | actually changed rows (rows modified in `UPDATE`) |
| `insertId` | int or null | auto-increment id on `INSERT`; `null` otherwise |
| `durationMs` | int | execution duration |

## 5. JSON Serialization Semantics

Row values of `mysql_query` are serialized per the following rules, **unified inside a single returned object — bare JSON is not returned directly**:

| MySQL type | Output type | Rule |
| --- | --- | --- |
| `BIGINT` / extra-large integers | string | **returned as string to avoid JS number precision loss** |
| `DECIMAL` / `NUMERIC` | string | string preserves exact decimals (prevents float errors) |
| Other integers / floats | number | normal numeric value |
| `DATETIME` / `TIMESTAMP` / `DATE` / `TIME` | string (ISO-8601 or MySQL native format) | returns the string MySQL returned; timezone is set by the connection `timezone` config (default server-local), not forced to UTC |
| `BINARY` / `VARBINARY` / `BLOB` | string (base64) | binary is returned as a base64-encoded string to avoid invalid UTF-8 breaking the protocol |
| `BIT` | string | bit sequence as a string (e.g. `"1010"`) |
| `JSON` | string | returns the JSON text as-is (client does the second parse) |
| `ENUM` / `SET` | string | raw string |
| `NULL` | null | kept as `null` |
| Unsupported types | string | best effort as string; if serialization is impossible → `SERIALIZE` error code |

**Note**: `timestamp` and `datetime` return the driver-observed string to avoid ambiguity from a second timezone conversion; the docs agree the server does no implicit timezone conversion.

## 6. SQL Policy Decision Table

Classification uses an **AST parser** (not regex/string prefix) to classify statements, then applies dangerous-feature checks. Parse failure or inability to classify deterministically → always rejected (`POLICY_REJECTED`).

| SQL category | Example | `mysql_query` | `mysql_execute` |
| --- | --- | --- | --- |
| `SELECT` (pure read-only, no side effects) | `SELECT * FROM t WHERE id=?` | ✅ | ⛔ |
| `SELECT` + CTE (`WITH`) | `WITH c AS (...) SELECT ...` | ✅ (read-only clauses only) | ⛔ |
| `SELECT ... FOR UPDATE / LOCK IN SHARE MODE` | `SELECT ... FOR UPDATE` | ⛔ locking read | ⛔ |
| `SELECT ... INTO OUTFILE/DUMPFILE` | `SELECT ... INTO OUTFILE ...` | ⛔ (file output) | ⛔ |
| `SELECT` + user-variable assignment | `SELECT @x := ...` | ⛔ | ⛔ |
| `SELECT` + dangerous built-in side-effect functions | `SELECT SLEEP(10)`, `BENCHMARK(...)` | ⛔ (denylist) | ⛔ |
| `SHOW` (informational) | `SHOW TABLES`, `SHOW DATABASES` | ✅ | ⛔ |
| `EXPLAIN` / `DESCRIBE` | `EXPLAIN SELECT ...`, `DESCRIBE t` | ✅ | ⛔ |
| `INSERT INTO ... VALUES` | `INSERT INTO t (a) VALUES (?)` | ⛔ | ✅ (parameterized) |
| `INSERT INTO ... SELECT` | `INSERT INTO a SELECT * FROM b` | ⛔ | ⛔ |
| `REPLACE` | `REPLACE INTO t ...` | ⛔ | ⛔ |
| `UPDATE t SET ... WHERE ...` | `UPDATE t SET a=? WHERE id=?` | ⛔ | ✅ (must have WHERE) |
| `UPDATE` without `WHERE` | `UPDATE t SET a=?` | ⛔ | ⛔ rejected |
| `DELETE FROM t WHERE ...` | `DELETE FROM t WHERE id=?` | ⛔ | ✅ (must have WHERE) |
| `DELETE` without `WHERE` | `DELETE FROM t` | ⛔ | ⛔ rejected |
| Multi-table writes (`UPDATE ... JOIN` / `DELETE ... USING`) | `UPDATE a JOIN b ...` | ⛔ | ⛔ |
| `DML + ON DUPLICATE KEY UPDATE` (upsert) | `INSERT ... ON DUPLICATE KEY UPDATE ...` | ⛔ | ⛔ |
| DDL (`CREATE/ALTER/DROP/TRUNCATE/RENAME`) | `DROP TABLE t` | ⛔ | ⛔ |
| DCL (`GRANT/REVOKE`) | `GRANT SELECT ...` | ⛔ | ⛔ |
| TCL (`BEGIN/COMMIT/ROLLBACK/SAVEPOINT`) | `BEGIN` | ⛔ | ⛔ |
| `CALL` stored procedure | `CALL proc()` | ⛔ | ⛔ |
| PREPARE/EXECUTE (dynamic SQL) | `PREPARE s FROM ...` | ⛔ | ⛔ |
| Others (`LOCK/UNLOCK`, `USE`, `SET`, etc.) | `USE db`, `SET autocommit=...` | ⛔ | ⛔ |

**Universal mandatory rules (always in effect for both SQL tools)**

- **Multi-statement detection**: multiple statements split by delimiters in a single call → rejected. The driver must be configured with `multipleStatements: false` with backend validation as fallback.
- **Comments/version comments**: `--`, `#`, `/* */` comments must be correctly stripped before classification; version-comment content (`/*! ... */`) is also parsed and classified, so comment syntax cannot bypass checks.
- **Case/whitespace**: classification is case-insensitive and extra-whitespace-insensitive (cannot be bypassed by rewriting).
- **AST parse failure**: always rejected with `POLICY_REJECTED`; no partial statement is executed.
- **Denylisted functions/keywords**: `SLEEP`, `BENCHMARK`, `LOAD_FILE`, `OUTFILE`, `DUMPFILE`, `@user_var` side effects, etc., are blacklisted.

> **Declarative statement**: SQL application-layer validation is the first line of defense-in-depth; **the ultimate security boundary is MySQL account permissions**. Even if a SQL statement is wrongly allowed, the low-privilege account still rejects its unauthorized execution.

## 7. Database Account Permission Matrix

At deployment, accounts **must** be created and authorized by pattern. It is recommended to name the read-only account `mysql_mcp_ro` and the writable account `mysql_mcp_rw` (writable only for write data sources).

### 7.1 Read-Only Account (default mode)

```sql
-- Example: grant only read-only privileges on the target database
CREATE USER 'mysql_mcp_ro'@'%' IDENTIFIED BY '<strong password>';
GRANT SELECT ON `app`.* TO 'mysql_mcp_ro'@'%';
GRANT SHOW VIEW ON `app`.* TO 'mysql_mcp_ro'@'%';
-- Metadata tools need information_schema reads (granted by default)
FLUSH PRIVILEGES;
```

| Privilege | Read-only account | Description |
| --- | --- | --- |
| `SELECT` | ✅ | data reads |
| `SHOW VIEW` | ✅ | view metadata |
| `SHOW DATABASES` | ✅ (or determined by the account's visible list) | used by `list_databases` |
| `INSERT` / `UPDATE` / `DELETE` | ⛔ | disabled for read-only |
| DDL (`CREATE/ALTER/DROP/INDEX/TRIGGER`) | ⛔ | disabled |
| DCL / user management (`GRANT/CREATE USER`) | ⛔ | disabled |
| `FILE` | ⛔ | file read/write forbidden |
| `PROCESS` | ⛔ | peeking at other sessions forbidden |
| `RELOAD` | ⛔ | server-level reload forbidden |
| `SUPER` / `SYSTEM_VARIABLES_ADMIN` | ⛔ | high privilege forbidden |

### 7.2 Controlled-Write Account (write data sources only)

```sql
CREATE USER 'mysql_mcp_rw'@'%' IDENTIFIED BY '<strong password>';
GRANT SELECT, SHOW VIEW ON `app`.* TO 'mysql_mcp_rw'@'%';
GRANT INSERT, UPDATE, DELETE ON `app`.* TO 'mysql_mcp_rw'@'%';
FLUSH PRIVILEGES;
```

Adds controlled DML on top of the read-only account, **keeping all other privileges disabled** (especially `FILE`, `PROCESS`, DDL, `GRANT`).

### 7.3 Per-Source `allowWrite` Dimension

Write capability has been refined from a "single global switch" to **optional per data source** (`allowWrite`); account authorization must align with each source's `allowWrite`:

| Data source `allowWrite` | Recommended account | `mysql_execute` behavior |
| --- | --- | --- |
| `false` (default) | read-only account `mysql_mcp_ro` | call returns `WRITE_DISABLED` |
| `true` | controlled-write account `mysql_mcp_rw` | controlled DML allowed, executed transactionally |

Within the same config file, each source can independently choose a read-only or writable account; read-only sources use a low-privilege account, and a writable source configures `mysql_mcp_rw` only when its `allowWrite=true`.

### 7.4 Account Authorization Principles

1. **Least privilege**: grant only the target business database, not `*.*`.
2. **Write-account separation**: the writable account is used only when the corresponding data source has `allowWrite=true`, and is also database-scoped.
3. **Forbidden**: `FILE`, `PROCESS`, user management, DDL privileges, and connecting production with a high-privilege `root` account.
4. **Read-only account first**: default (`allowWrite=false`) data sources must use a read-only account; do not grant write privileges just because it is read-only mode.
5. Production connections go over TLS with strong passwords (not written to docs or logs; passwords are passed via `${VAR}` env-var references, plaintext in memory only).

## 8. Security Boundary Summary (Defense in Depth)

| Layer | Mechanism |
| --- | --- |
| Transport/protocol | stdio only, stdout carries only protocol frames, logs go to stderr |
| Config | JSON file declares multiple sources (`MCP_SOURCES_FILE`), fail-fast, target/default-source validation; passwords via `${VAR}` reference and never logged |
| Parameter validation | Schema (`additionalProperties:false`), length/count/range caps, per-source limits |
| SQL policy | AST classification + dangerous features + multi-statement/comment handling + blacklist |
| Tool isolation | read/write capability isolated per **per-data-source `allowWrite`**; write tool always registered but gated per source |
| Execution limits | query timeout, max-row truncation, write affected-row cap, transaction rollback |
| Database privilege | lowest-privilege account as fallback (the real security boundary) |
| Log redaction | passwords (incl. `${VAR}`-expanded plaintext)/full SQL never logged; correlation ID for troubleshooting |
