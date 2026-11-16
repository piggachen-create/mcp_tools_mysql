# MySQL MCP Tool 工具契约与安全设计

本文档定义 5 个 MCP 工具的输入/输出 Schema、SQL 策略决策表、数据库账号权限矩阵、JSON 序列化语义，以及安全边界约定。所有内容与 [架构设计](architecture.md)、[测试矩阵与实施路线](testing-and-roadmap.md) 保持一致。

## 1. 工具总览

| 工具 | 输入 | 输出 | 默认注册 |
| --- | --- | --- | --- |
| `mysql_list_databases` | 无 | 数据库名列表 | ✅ |
| `mysql_list_tables` | `schema`(必填) | 表/视图名列表 | ✅ |
| `mysql_describe_table` | `table`(必填)，`schema`(可选) | 字段结构 | ✅ |
| `mysql_query` | `sql`、`params`、`maxRows`、`timeoutMs` | 列元数据 + 行 + 标志位 | ✅ |
| `mysql_execute` | `sql`、`params` | 影响/变更行数、插入 ID、耗时 | ⛔ 仅开启写入后 |

所有工具输出均在 MCP `content[].text` 中以 JSON 字符串返回；执行语义错误通过 `isError: true` + 脱敏消息返回。

**共同约定**

- 未知/多余字段：默认拒绝（`additionalProperties: false`），避免调用者注入意外字段。
- 所有字符串字段做长度上限校验（受 `MYSQL_SQL_MAX_LENGTH` 等服务端限制约束）。
- 调用者不得传入连接凭据、目标库连接串、超范围 `maxRows`、非 `SELECT` 期望的操作。

## 2. 只读元数据工具

### 2.1 `mysql_list_databases`

输入 Schema：无（`{}`）。

输出：

```json
{
  "databases": ["information_schema", "app", "analytics"],
  "truncated": false
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `databases` | string[] | 是 | 当前账号可见的数据库名 |
| `truncated` | boolean | 是 | 结果是否因数量超限被截断 |

空结果：`{"databases": [], "truncated": false}`。

### 2.2 `mysql_list_tables`

输入：

```json
{
  "schema": "app"
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `schema` | string | 是 | 无 | 1–128 字符，合法标识符字符集 `[a-zA-Z0-9_$]` |

输出：

```json
{
  "schema": "app",
  "tables": ["users", "orders", "v_active_users"],
  "truncated": false
}
```

空结果：`{"schema":"app","tables":[],"truncated":false}`。

### 2.3 `mysql_describe_table`

输入：

```json
{
  "table": "users",
  "schema": "app"
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `table` | string | 是 | 无 | 1–128 字符合法标识符 |
| `schema` | string | 否 | 账号默认库 | 存在则 1–128 字符合法标识符；不存在时使用 `MYSQL_DATABASE` |

输出（列结构取自 `information_schema.COLUMNS` 或 `SHOW COLUMNS`）：

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

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 列名 |
| `type` | string | 是 | 列类型（如 `bigint`、`varchar`） |
| `nullable` | boolean | 是 | 是否允许 NULL |
| `key` | string | 是 | 键类型：`PRI`/`UNI`/`MUL`/`""` |
| `default` | string or null | 是 | 默认值 |
| `extra` | string | 是 | 扩展（`auto_increment` 等） |

空结果：`{"schema":"app","table":"users","columns":[]}`（表不存在则返回 `PARAM` 类错误）。

## 3. `mysql_query`（只读查询）

### 3.1 输入

```json
{
  "sql": "SELECT id, name, balance FROM users WHERE status = ?",
  "params": [1],
  "maxRows": 100,
  "timeoutMs": 5000
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `sql` | string | 是 | 无 | 长度 ≤ `MYSQL_SQL_MAX_LENGTH`（默认 16384）；去除首尾空白后非空 |
| `params` | array | 否 | `[]` | 元素数 ≤ `MYSQL_MAX_PARAMS`（默认 500）；元素仅允许标量类型 |
| `maxRows` | int | 否 | `MYSQL_MAX_ROWS`(1000) | 1–`MYSQL_MAX_ROWS`，且 ≤ 服务设置上限 |
| `timeoutMs` | int | 否 | `MYSQL_QUERY_TIMEOUT_MS`(30000) | 100–`MYSQL_QUERY_TIMEOUT_MS`（≤ 服务上限） |

**输入校验失败**返回 `PARAM` 错误码（脱敏 details 指明字段）。

### 3.2 执行约束

- **仅允许只读语句**：经 SQL 分类器判定为只读（`SELECT` / `SHOW` / `EXPLAIN` 等的允许子集）才放行，详见第 6 节决策表。
- **参数化**：`params` 通过预编译占位符（`?`）绑定，绝不拼接进 SQL。
- **禁止**：多语句、`FOR UPDATE`/`LOCK IN SHARE MODE` 锁定读取、`INTO OUTFILE`、`CALL`、用户变量副作用、跨语句状态等，见第 6 节。
- **只读账号**：底层使用只读账号，即便应用层误放行，数据库权限仍会兜底拒绝。

### 3.3 输出

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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `columns` | string[] | 列名（保持结果集顺序） |
| `columnTypes` | string[] | 每列 MySQL 类型名 |
| `rows` | array of arrays | 行数据，每行与 `columns` 等长；值为已序列化 JSON 标量或 `null` |
| `rowCount` | int | 实际返回行数 |
| `truncated` | boolean | 是否因 `maxRows` 截断（真表示还有更多行未返回） |
| `durationMs` | int | 本次查询服务端耗时（毫秒） |

**空结果**：`{"columns":[],"rows":[],"columnTypes":[],"rowCount":0,"truncated":false,"durationMs":1}`。

**超限处理**：查询结果超过 `maxRows` 时只返回前 `maxRows` 行并置 `truncated: true`；不报错。真正抛错的是 [第 6 节](#6-sql-策略决策表) 不允许的语句（返回 `POLICY_REJECTED`）。

### 3.4 示例

成功示例（参数化、限行、超时）：

```json
{
  "sql": "SELECT id, name, balance FROM users WHERE status = ? ORDER BY id LIMIT 5",
  "params": [1],
  "maxRows": 100,
  "timeoutMs": 5000
}
```

拒绝示例（`POLICY_REJECTED`）：

```text
// 输入：多语句
{ "sql": "SELECT 1; DROP TABLE users" }
// 输入：锁定读取
{ "sql": "SELECT * FROM users WHERE id = 1 FOR UPDATE" }
// 输入：文件输出
{ "sql": "SELECT * INTO OUTFILE '/tmp/x.csv' FROM users" }
```

## 4. `mysql_execute`（受控写入）

**条件注册**：仅当服务端 `MYSQL_ALLOW_WRITE=true` 时该工具才会出现在工具列表中；默认不注册。写入开关只在启动阶段决定，**运行期无法通过 MCP 请求打开**。

### 4.1 输入

```json
{
  "sql": "UPDATE users SET balance = ? WHERE id = ?",
  "params": [100.00, 42]
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `sql` | string | 是 | 无 | 长度 ≤ `MYSQL_SQL_MAX_LENGTH` |
| `params` | array | 否 | `[]` | 元素数 ≤ `MYSQL_MAX_PARAMS`；仅标量 |

### 4.2 允许的写入形态

| 形态 | 允许 | 示例 |
| --- | --- | --- |
| `INSERT INTO t (cols) VALUES (...)` | ✅ | `INSERT INTO users (name) VALUES (?)` |
| `INSERT INTO t (cols) VALUES (...),(...)` 多值 | ✅ | 批量多值插入 |
| `UPDATE t SET ... WHERE ...` | ✅ | **必须带非空 `WHERE`** |
| `DELETE FROM t WHERE ...` | ✅ | **必须带非空 `WHERE`** |
| 无条件 `UPDATE` / `DELETE` | ⛔ | `UPDATE users SET x=1` |
| `INSERT ... SELECT` | ⛔ | `INSERT INTO a SELECT * FROM b` |
| `REPLACE` / upsert（`ON DUPLICATE KEY UPDATE`） | ⛔ | `REPLACE INTO ...` / `INSERT ... ON DUPLICATE KEY UPDATE ...` |
| 多表写入 | ⛔ | `UPDATE a JOIN b ...` / `DELETE a FROM a JOIN b ...` |
| DDL / DCL / TCL / `CALL` | ⛔ | 见第 6 节 |

### 4.3 事务化执行

1. `BEGIN`
2. 执行参数化语句
3. 读取影响行数（`affectedRows`）
4. 若 `affectedRows > MYSQL_MAX_AFFECTED_ROWS`（默认 1000）→ `ROLLBACK`，返回 `RESULT_LIMIT`
5. 否则 `COMMIT`

任何异常 → `ROLLBACK`，返回对应错误码（连接/超时/策略等）。**绝不部分提交**。

### 4.4 输出

```json
{
  "affectedRows": 1,
  "changedRows": 1,
  "insertId": 0,
  "durationMs": 8
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `affectedRows` | int | 受影响行数（`INSERT` 为插入行数） |
| `changedRows` | int | 实际变更行数（`UPDATE` 中被修改的行） |
| `insertId` | int or null | `INSERT` 时的自增 ID；无则为 `null` |
| `durationMs` | int | 执行耗时 |

## 5. JSON 序列化语义

`mysql_query` 的行值按如下规则序列化，**统一封装在一个返回对象内，不直接返回裸 JSON**：

| MySQL 类型 | 输出类型 | 规则 |
| --- | --- | --- |
| `BIGINT` / 超大整数 | string | **以字符串返回，避免 JS number 精度丢失** |
| `DECIMAL` / `NUMERIC` | string | 以字符串保留精确小数（防止浮点误差） |
| 其它整数 / 浮点 | number | 正常数值 |
| `DATETIME` / `TIMESTAMP` / `DATE` / `TIME` | string（ISO-8601 或 MySQL 原生格式） | 返回 MySQL 返回的字符串；时区由连接 `timezone` 配置决定（默认服务器本地时区），不强制 UTC |
| `BINARY` / `VARBINARY` / `BLOB` | string（base64） | 二进制以 base64 编码字符串返回，避免非法 UTF-8 破坏协议 |
| `BIT` | string | 以字符串返回位序列（如 `"1010"`） |
| `JSON` | string | 返回 JSON 文本原样（客户端负责二次解析） |
| `ENUM` / `SET` | string | 原样字符串 |
| `NULL` | null | 保持为 `null` |
| 未支持类型 | string | 以字符串形式尽力返回；若无法序列化 → `SERIALIZE` 错误码 |

**说明**：`timestamp` 与 `datetime` 返回驱动所见字符串，避免时区二次转换造成歧义；文档约定服务端不做隐式时区换算。

## 6. SQL 策略决策表

判定采用 **AST 解析器**（非正则/字符串前缀）完成语句分类，再叠加危险特征检查。解析失败或无法确定性分类 → 一律拒绝（`POLICY_REJECTED`）。

| SQL 类别 | 示例 | `mysql_query` | `mysql_execute` |
| --- | --- | --- | --- |
| `SELECT`（纯只读，无副作用） | `SELECT * FROM t WHERE id=?` | ✅ | ⛔ |
| `SELECT` + CTE（`WITH`） | `WITH c AS (...) SELECT ...` | ✅（仅含只读子句） | ⛔ |
| `SELECT ... FOR UPDATE / LOCK IN SHARE MODE` | `SELECT ... FOR UPDATE` | ⛔ 锁定读取 | ⛔ |
| `SELECT ... INTO OUTFILE/DUMPFILE` | `SELECT ... INTO OUTFILE ...` | ⛔（文件输出） | ⛔ |
| `SELECT` + 用户变量赋值 | `SELECT @x := ...` | ⛔ | ⛔ |
| `SELECT` + 危险内建副作用函数 | `SELECT SLEEP(10)`、`BENCHMARK(...)` | ⛔（拒绝名单） | ⛔ |
| `SHOW`（信息型） | `SHOW TABLES`、`SHOW DATABASES` | ✅ | ⛔ |
| `EXPLAIN` / `DESCRIBE` | `EXPLAIN SELECT ...`、`DESCRIBE t` | ✅ | ⛔ |
| `INSERT INTO ... VALUES` | `INSERT INTO t (a) VALUES (?)` | ⛔ | ✅（参数化） |
| `INSERT INTO ... SELECT` | `INSERT INTO a SELECT * FROM b` | ⛔ | ⛔ |
| `REPLACE` | `REPLACE INTO t ...` | ⛔ | ⛔ |
| `UPDATE t SET ... WHERE ...` | `UPDATE t SET a=? WHERE id=?` | ⛔ | ✅（必带 WHERE） |
| `UPDATE` 无 `WHERE` | `UPDATE t SET a=?` | ⛔ | ⛔ 拒绝 |
| `DELETE FROM t WHERE ...` | `DELETE FROM t WHERE id=?` | ⛔ | ✅（必带 WHERE） |
| `DELETE` 无 `WHERE` | `DELETE FROM t` | ⛔ | ⛔ 拒绝 |
| 多表写入（`UPDATE ... JOIN` / `DELETE ... USING`） | `UPDATE a JOIN b ...` | ⛔ | ⛔ |
| `DML + ON DUPLICATE KEY UPDATE`（upsert） | `INSERT ... ON DUPLICATE KEY UPDATE ...` | ⛔ | ⛔ |
| DDL（`CREATE/ALTER/DROP/TRUNCATE/RENAME`） | `DROP TABLE t` | ⛔ | ⛔ |
| DCL（`GRANT/REVOKE`） | `GRANT SELECT ...` | ⛔ | ⛔ |
| TCL（`BEGIN/COMMIT/ROLLBACK/SAVEPOINT`） | `BEGIN` | ⛔ | ⛔ |
| `CALL` 存储过程 | `CALL proc()` | ⛔ | ⛔ |
| PREPARE/EXECUTE（动态 SQL） | `PREPARE s FROM ...` | ⛔ | ⛔ |
| 其它（`LOCK/UNLOCK`、`USE`、`SET` 等） | `USE db`、`SET autocommit=...` | ⛔ | ⛔ |

**通用强制规则（对两个 SQL 工具始终生效）**

- **多语句检测**：单个调用中出现多个由分隔符拆分的语句 → 拒绝。驱动需配置 `multipleStatements: false` 并以后端校验兜底。
- **注释/版本注释**：`--`、`#`、`/* */` 注释必须能正确剥离后分类；版本注释（`/*! ... */`）内容也会被解析分类，不因注释语法绕过检查。
- **大小写/空白**：分类对大小写不敏感、对多余空白不敏感（不能靠改写法绕过）。
- **AST 解析失败**：一律拒绝并返回 `POLICY_REJECTED`，不执行任何部分语句。
- **拒绝名单函数/关键字**：`SLEEP`、`BENCHMARK`、`LOAD_FILE`、`OUTFILE`、`DUMPFILE`、`@user_var` 副作用等列入黑名单。

> **结论性声明**：SQL 应用层校验属于纵深防御的第一道防线，**最终安全边界是 MySQL 账号权限**。即使某条 SQL 被误放行，低权限账号仍会拒绝其越权执行。

## 7. 数据库账号权限矩阵

部署时**必须**创建账号并按模式授权。推荐命名建议只读 `mysql_mcp_ro`、可写 `mysql_mcp_rw`（仅开启写入时使用）。

### 7.1 只读账号（默认模式）

```sql
-- 示例：仅授予目标库的只读权限
CREATE USER 'mysql_mcp_ro'@'%' IDENTIFIED BY '<强密码>';
GRANT SELECT ON `app`.* TO 'mysql_mcp_ro'@'%';
GRANT SHOW VIEW ON `app`.* TO 'mysql_mcp_ro'@'%';
-- 元数据工具需要 information_schema 读取（默认已授予）
FLUSH PRIVILEGES;
```

| 权限 | 只读账号 | 说明 |
| --- | --- | --- |
| `SELECT` | ✅ | 数据读取 |
| `SHOW VIEW` | ✅ | 视图元数据 |
| `SHOW DATABASES` | ✅（或由账号可见列表决定） | `list_databases` 使用 |
| `INSERT` / `UPDATE` / `DELETE` | ⛔ | 只读禁用 |
| DDL（`CREATE/ALTER/DROP/INDEX/TRIGGER`） | ⛔ | 禁用 |
| DCL / 用户管理（`GRANT/CREATE USER`） | ⛔ | 禁用 |
| `FILE` | ⛔ | 禁止文件读写 |
| `PROCESS` | ⛔ | 禁止窥探其它会话 |
| `RELOAD` | ⛔ | 禁止服务器级重载 |
| `SUPER` / `SYSTEM_VARIABLES_ADMIN` | ⛔ | 禁止高权 |

### 7.2 受控写账号（仅 `MYSQL_ALLOW_WRITE=true`）

```sql
CREATE USER 'mysql_mcp_rw'@'%' IDENTIFIED BY '<强密码>';
GRANT SELECT, SHOW VIEW ON `app`.* TO 'mysql_mcp_rw'@'%';
GRANT INSERT, UPDATE, DELETE ON `app`.* TO 'mysql_mcp_rw'@'%';
FLUSH PRIVILEGES;
```

在只读账号基础上追加受控 DML，**保持其它权限一律禁用**（尤其 `FILE`、`PROCESS`、DDL、`GRANT`）。

### 7.3 账号授权原则

1. **最小权限**：只授予目标业务库，不授予 `*.*`。
2. **写账号分离**：可写账号仅在开启写入时使用，并同样限制库范围。
3. **禁止**：`FILE`、`PROCESS`、用户管理、DDL 权限，以及生产环境使用高权限 `root` 接入。
4. **只读账号先行**：默认模式必须使用只读账号；不要因为只读模式就把写入权限误授。
5. 生产环境连接走 TLS，并设置强密码（不落文档、不进日志）。

## 8. 安全边界汇总（纵深防御）

| 层级 | 机制 |
| --- | --- |
| 传输/协议 | stdio 专用、stdout 仅协议帧、日志走 stderr |
| 配置 | 连接凭据仅服务端环境变量、fail-fast、敏感配置不记日志 |
| 参数校验 | Schema（`additionalProperties:false`）、长度/数量/范围上限 |
| SQL 策略 | AST 分类 + 危险特征 + 多语句/注释处理 + 黑名单 |
| 工具隔离 | 默认无写入工具、写入开关仅启动时决定 |
| 执行限制 | 查询超时、最大行数截断、写入影响行数上限、事务回滚 |
| 数据库权限 | 最小权限账号兜底（真正安全边界） |
| 日志脱敏 | 密码/完整 SQL 不落日志、关联 ID 排查 |
