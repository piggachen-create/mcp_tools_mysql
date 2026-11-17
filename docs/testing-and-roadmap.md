# MySQL MCP Tool — Testing Matrix & Implementation Roadmap

This document defines the testing strategy (unit / integration / security regression) for the MySQL MCP service and the acceptance criteria for the M0–M4 implementation phases. All terms, tool names, config names, defaults, and error codes are consistent with [Architecture](architecture.md) and [Tool Contracts & Security Design](tool-contracts-and-security.md).

> **中文版**: 本文件的中文平行版见 [testing-and-roadmap.zh-CN.md](testing-and-roadmap.zh-CN.md)。

## 1. Testing Layers Overview

| Layer | Goal | Dependencies | Speed |
| --- | --- | --- | --- |
| Unit tests | config/classification/error-mapping/serialization/limit logic | no external dependencies (Mock-driven) | fast |
| Integration tests | read-only and writable account behavior | real MySQL (Docker possible) | medium |
| MCP protocol tests | initialization, tool registration, stdout purity, shutdown cleanup | simulated stdio client | medium |
| Security regression tests | attack-bypass samples | real MySQL + low-privilege account | medium |

## 2. Unit Test Matrix

### 2.1 Multi-Data-Source Config Parsing (`loadSourcesConfig`)

| Case | Input | Expected result |
| --- | --- | --- |
| All valid | valid JSON (global + multiple sources) | parse succeeds, defaults correct |
| Minimal config | only `sources` required fields, no global | global uses defaults; `defaultTarget` = first source |
| Password missing | a source lacks `password` | fail-fast, `CONFIG_INVALID` |
| Password `${VAR}` reference | `"password": "${MYSQL_PASSWORD}"` | expands to env value; variable missing or empty fails fast |
| `defaultTarget` invalid | points to a nonexistent source | fail-fast |
| target rules | empty/over 64 chars/invalid chars/duplicate | fail-fast |
| Global-only in source | source contains `poolSize`/`poolIdleTimeoutMs`/`logLevel` | fail-fast |
| Connection params in global | `global.host` etc. | fail-fast |
| Port out of range | `port=0` or `70000` | fail-fast |
| Non-standard boolean | `tls=1` / `yes` / `on` | fail-fast (rejects `1/yes/no`) |
| Boolean case | `allowWrite=True` | parses to true |
| Numeric out of range | `maxRows=0` / `20000` | fail-fast |
| Numeric non-numeric | `poolSize=abc` | fail-fast |
| Time unit | `queryTimeoutMs=50` | fail-fast (below 100) |
| Invalid log level | `logLevel=verbose` | fail-fast |
| Three-level merge | source explicit / global value / built-in default | merge order source > global > default |

### 2.2 registry / `ConnectionManager` Matrix

| Case | Input | Expected result |
| --- | --- | --- |
| Always register 5 tools | `tools/list` after any config startup | always includes `mysql_execute`, total 5 tools |
| Unknown target | `target="ghost"` on any tool | `PARAM`, `details.target=ghost` |
| `configFor` default | `configFor()` no args | returns the `defaultTarget` source config |
| `resolve` default | `resolve()` no args | falls back to the default source executor |
| Lazy per-source pool | visit multiple targets in sequence | each target's pool created on first visit, reused |
| `endAll` converge | on shutdown | all created pools closed, no leaks |

### 2.3 Target Dispatch Matrix

| Case | Input | Expected result |
| --- | --- | --- |
| Read-only per-source limit | `target=replica` (`maxRows=2000`) runs `mysql_query` over 1000 rows | truncated per that source's cap |
| Write per-source switch | `target=readonly` calls `mysql_execute` | `WRITE_DISABLED` |
| Write per-source cap | `target=write-pool` (`maxAffectedRows=500`) over cap | `RESULT_LIMIT` and rollback |
| Per-source `sqlMaxLength` | over that source's `sqlMaxLength` | `PARAM`, details carry the source cap |
| Two-layer validation (query) | registration global default passes, runtime a source cap is smaller | runtime per-source re-validation returns `PARAM` |

### 2.4 SQL Classifier

| Case | Input | Expected classification/judgment |
| --- | --- | --- |
| Pure read-only | `SELECT a FROM t WHERE id=?` | ✅ query allowed |
| CTE read-only | `WITH c AS (SELECT 1) SELECT * FROM c` | ✅ query allowed |
| Case | `sElEcT * FrOm t` | ✅ (case-insensitive) |
| Extra whitespace | `SELECT\n * FROM\tt` | ✅ (whitespace-insensitive) |
| Comments | `-- hi\nSELECT * FROM t`, `/*x*/ SELECT 1` | ✅ (classified after stripping) |
| Version comments | `/*!50000 SELECT 1 */` | ✅ (content still classified) |
| Locking read | `SELECT ... FOR UPDATE` | ⛔ query rejected |
| File output | `SELECT ... INTO OUTFILE ...` | ⛔ rejected |
| User-variable side effect | `SELECT @x := 1` | ⛔ rejected |
| Dangerous functions | `SELECT SLEEP(10)`, `SELECT BENCHMARK(...)` | ⛔ rejected (blacklist) |
| Multiple statements | `SELECT 1; DROP TABLE t` | ⛔ rejected (multi-statement) |
| Unconditional update | `UPDATE t SET a=1` | ⛔ execute rejected |
| Update with WHERE | `UPDATE t SET a=? WHERE id=?` | ✅ execute allowed |
| Unconditional delete | `DELETE FROM t` | ⛔ execute rejected |
| INSERT VALUES | `INSERT INTO t (a) VALUES (?)` | ✅ execute allowed |
| INSERT SELECT | `INSERT INTO a SELECT * FROM b` | ⛔ execute rejected |
| REPLACE | `REPLACE INTO t VALUES (1)` | ⛔ rejected |
| upsert | `INSERT ... ON DUPLICATE KEY UPDATE ...` | ⛔ rejected |
| Multi-table write | `UPDATE a JOIN b ...` | ⛔ rejected |
| DDL | `DROP TABLE t`, `ALTER TABLE ...` | ⛔ rejected |
| DCL | `GRANT SELECT ...` | ⛔ rejected |
| TCL | `BEGIN` / `COMMIT` / `ROLLBACK` | ⛔ rejected |
| CALL | `CALL p()` | ⛔ rejected |
| PREPARE/EXECUTE | `PREPARE s FROM ...` | ⛔ rejected |
| Parse failure | syntax-invalid/truncated text | ⛔ rejected (`POLICY_REJECTED`) |

## 3. Serialization & Limit-Logic Tests

| Case | Input | Expected result |
| --- | --- | --- |
| BIGINT precision | `9223372036854775807` | returns string `"9223372036854775807"` |
| DECIMAL precision | `1234.567890123456` | returns string |
| DATETIME | server-local timezone value | returns MySQL's raw string |
| Binary | `0x00FF` | base64 string |
| BIT | `b'1010'` | string `"1010"` |
| NULL | NULL column | JSON `null` |
| JSON field | `{"a":1}` | raw JSON text |
| Row truncation | result > `maxRows` | `truncated:true` + only first `maxRows` rows |
| Affected rows over limit | `affectedRows > the source's maxAffectedRows` | `RESULT_LIMIT`, and transaction rolled back |

## 4. Integration Tests

**Prerequisites**: an available MySQL (with Docker, `docker run` a MySQL 8.x), two accounts prepared (read-only `mysql_mcp_ro`, writable `mysql_mcp_rw`), and one write-disabled source plus one write-enabled source.

| Case | Account | Scenario | Expected |
| --- | --- | --- | --- |
| Read-only query | ro | `SELECT` normal | returns correct rows |
| Read-only mis-write | ro | calls `INSERT` | application-layer `POLICY_REJECTED` (if bypassed) → database privilege rejects |
| Metadata | ro | `list_databases`/`list_tables`/`describe_table` | returns the visible list |
| Write-disabled source | ro | calls `mysql_execute` on an `allowWrite=false` source | `WRITE_DISABLED` |
| Write-enabled source | rw | `INSERT`/`UPDATE` with `WHERE`/`DELETE` on an `allowWrite=true` source | transaction commits, row count correct |
| Write over cap | rw | `affectedRows` exceeds the source's `maxAffectedRows` | rollback, no side-effect residue |
| Write exception | rw | error midway | rollback, returns corresponding error code |

## 5. MCP Protocol Tests

| Case | Scenario | Expected |
| --- | --- | --- |
| Init handshake | send `initialize` | returns protocol version, capabilities, tool list |
| Tool list — always 5 tools | `tools/list` under any config | always includes `mysql_execute`, total 5 tools |
| Write per-source gating | calls `mysql_execute` on an `allowWrite=false` source | `WRITE_DISABLED`; tool list still includes `mysql_execute` |
| Write switch not dynamic | try to enable writes at runtime | no such mechanism; per-source `allowWrite` unchanged |
| Unknown target | pass `target=ghost` | `PARAM` error |
| stdout purity | startup + multiple tool calls | `stdout` contains only valid MCP frames, no logs/no diagnostics |
| Logs go to stderr | any call + error | redacted logs appear only in `stderr` |
| Process shutdown cleanup | send `SIGINT`/`SIGTERM` | `ConnectionManager.endAll()` called, process exits normally |
| Abnormal exit | uncaught exception | cleans up and exits, no resource leak |

## 6. Security Regression Tests (focus)

| # | Attack / bypass | Expected result |
| --- | --- | --- |
| S1 Multi-statement injection | `SELECT 1; DROP TABLE t` | rejected, table not dropped |
| S2 Comment bypass | `SELECT 1 --` + a second statement hidden after the comment | rejected |
| S3 Version-comment bypass | `/*!50000 SELECT ... INTO OUTFILE ... */` | rejected |
| S4 Locking read | `SELECT ... FOR UPDATE` | query rejected |
| S5 File output | `SELECT ... INTO OUTFILE` | rejected |
| S6 Unconditional write | `UPDATE t SET a=1` | execute rejected |
| S7 Multi-table write | `UPDATE a JOIN b ...` | rejected |
| S8 Sensitive-info leak | statement error/logging | logs contain no password and no full SQL body |
| S9 Big-bang query | overlong SQL / massive params | `PARAM` or length-cap rejection |
| S10 Credential injection into params | `params` passes connection string/newlines | only as bound values, no connection/semantics change |
| S11 Dangerous function | `SELECT SLEEP(100)` | blacklist rejection |
| S12 User-variable side effect | `SELECT @x := 1` | rejected |
| S13 Cross-database free access | query on an unauthorized database | database privilege rejects |
| S14 Timeout protection | long query > `timeoutMs` | `TIMEOUT` error, connection released |

## 7. Implementation Roadmap (M0–M4)

> **Current status**: M0–M4 are complete — the multi-data-source retrofit (JSON multi-source config, `ConnectionManager` lazy per-target multi-pools, `mysql_execute` always registered + per-source `allowWrite`) passes typecheck and all unit tests.

### M0 — Design Freeze (done)

- **Deliverables**: README + three design docs (the current repo has four docs in total with the variants).
- **Exit criteria**: design docs reviewed and approved; tools/config/error codes consistent across docs; multi-source config and per-source write-gating logic clear.

### M1 — Protocol Skeleton & Config

- **Deliverables**: Node/TS project, `main` entry, SDK Server, stdio transport, `loadSourcesConfig` multi-source parsing and fail-fast.
- **Exit criteria**: unit tests (multi-source config matrix) all green; handshake works, `tools/list` returns (no SQL needed yet).

### M2 — Read-Only Capabilities

- **Deliverables**: `ConnectionManager` + per-source connection pools, metadata service, `mysql_query`, serialization, error mapping, log redaction.
- **Exit criteria**: read-only tools usable (incl. multi-source target dispatch); integration + protocol tests pass; `stdout` pure.

### M3 — Controlled Writes

- **Deliverables**: `mysql_execute` always registered + per-source `allowWrite` gating, SQL write policy, transactional execution, affected-row-cap rollback, read/write account separation.
- **Exit criteria**: security regression cases (S-class) all green; per-source write enable/disable behavior correct.

### M4 — Release Preparation

- **Deliverables**: packaging scripts, `README` quick start fleshed out (multi-source example), final docs, example config/authorization scripts.
- **Exit criteria**: all tests pass; Gitee `main` default branch, docs and implementation consistent in repo, no sensitive-info leaks.

## 8. Consistency Commitment

- All docs and the implementation in this repo must obey the defaults in [Architecture · Configuration System](architecture.md#5-configuration-system) and the schemas in [Tool Contracts](tool-contracts-and-security.md).
- Any change to a default/error code/tool name must update the three design docs synchronously and add a case to the test matrix.
- Security regression tests (Section 6) are a release gate; no implementation may skip them on the excuse of "tests are hard to write".
