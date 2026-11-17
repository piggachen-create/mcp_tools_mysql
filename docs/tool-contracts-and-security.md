# MySQL MCP Tool 工具契约与安全设计

本文档定义 5 个 MCP 工具的输入/输出 Schema、SQL 策略决策表、数据库账号权限矩阵、JSON 序列化语义，以及安全边界约定。所有内容与 [架构设计](architecture.md)、[测试矩阵与实施路线](testing-and-roadmap.md) 保持一致。

## 1. 工具总览

| 工具 | 输入 | 输出 | 默认注册 |
| --- | --- | --- | --- |
| `mysql_list_databases` | `target`(可选) | 数据库名列表 | ✅ |
| `mysql_list_tables` | `target`(可选)、`schema`(必填) | 表/视图名列表 | ✅ |
| `mysql_describe_table` | `target`(可选)、`table`(必填)、`schema`(可选) | 字段结构 | ✅ |
| `mysql_query` | `target`(可选)、`sql`、`params`、`maxRows`、`timeoutMs` | 列元数据 + 行 + 标志位 | ✅ |
| `mysql_execute` | `target`(可选)、`sql`、`params` | 影响/变更行数、插入 ID、耗时 | ✅ 常注册（按源 `allowWrite` 判定可用性） |

所有工具输出均在 MCP `content[].text` 中以 JSON 字符串返回；执行语义错误通过 `isError: true` + 脱敏消息返回。

**共同约定**

- **`target`（全部工具可选的 `target` 字段）**：指定数据源标识，约束 1–64 字符、字符集为任意 Unicode 字母/数字（含中文等 CJK 字符）+ 下划线/连字符。缺省时落到服务端 `defaultTarget`（缺省取首 source）；未知 target 返回 `PARAM`（`details.target=...`）。
- 未知/多余字段：默认拒绝（`additionalProperties: false`），避免调用者注入意外字段。
- 所有字符串字段做长度上限校验（受该源 `sqlMaxLength` 等服务端限制约束）。
- 调用者不得传入连接凭据、目标库连接串、超范围 `maxRows`、非 `SELECT` 期望的操作。

## 2. 只读元数据工具

### 2.1 `mysql_list_databases`

输入 Schema：可选 `target`（指定数据源，缺省默认源）。

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
  "target": "app",
  "schema": "app"
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `target` | string | 否 | 默认源 | 1–64 字符，Unicode 字母/数字（含中文）+ `_`/`-`；指定数据源 |
| `schema` | string | 是 | 无 | 1–128 字符，合法标识符字符集 `[a-zA-Z0-9_$]` |

结果行数受该源 `maxRows` 限制，超限截断置 `truncated: true`。

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
  "target": "app",
  "table": "users",
  "schema": "app"
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `target` | string | 否 | 默认源 | 1–64 字符，Unicode 字母/数字（含中文）+ `_`/`-`；指定数据源 |
| `table` | string | 是 | 无 | 1–128 字符合法标识符 |
| `schema` | string | 否 | 该源默认库 | 存在则 1–128 字符合法标识符；不存在时使用该数据源的 `database` 字段 |

> **注意**：Schema 缺省语义按**目标数据源**的默认库（`DatasourceConfig.database`）取；若该源未配置默认库且未显式传 `schema`，返回 `PARAM`。

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
  "target": "app",
  "sql": "SELECT id, name, balance FROM users WHERE status = ?",
  "params": [1],
  "maxRows": 100,
  "timeoutMs": 5000
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `target` | string | 否 | 默认源 | 1–64 字符，Unicode 字母/数字（含中文）+ `_`/`-`；指定数据源 |
| `sql` | string | 是 | 无 | 长度 ≤ 该源 `sqlMaxLength`（默认 16384）；去除首尾空白后非空 |
| `params` | array | 否 | `[]` | 元素数 ≤ 该源 `maxParams`（默认 500）；元素仅允许标量类型 |
| `maxRows` | int | 否 | 该源 `maxRows`(1000) | 1–该源 `maxRows`，且 ≤ 源服务设置上限 |
| `timeoutMs` | int | 否 | 该源 `queryTimeoutMs`(30000) | 100–该源 `queryTimeoutMs`（≤ 源上限） |

**输入校验失败**返回 `PARAM` 错误码（脱敏 details 指明字段）。

**双层校验**：注册期 schema 以全局默认（`global` 合并值，用于 `tools/list` 展示顺序上限）；运行期在 handler 内再按**目标数据源**合并配置二次校验 `sqlMaxLength` / `maxParams` / `maxRows` / `queryTimeoutMs`，超限返回 `PARAM`（details 携带源上限值）。

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

**常注册 + 按源判定**：本工具**恒定出现在工具列表**（不再依赖全局开关决定是否注册）。运行期 handler 内按**目标数据源**的 `allowWrite` 判定可用性：该源未开启写入（源或 `global` 的 `allowWrite=false`）时返回 `WRITE_DISABLED`。写入可用性可按数据源独立控制，运行期无法通过 MCP 请求打开。

### 4.1 输入

```json
{
  "target": "write-pool",
  "sql": "UPDATE users SET balance = ? WHERE id = ?",
  "params": [100.00, 42]
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `target` | string | 否 | 默认源 | 1–64 字符，Unicode 字母/数字（含中文）+ `_`/`-`；指定数据源。该源 `allowWrite=false` 返回 `WRITE_DISABLED` |
| `sql` | string | 是 | 无 | 长度 ≤ 该源 `sqlMaxLength` |
| `params` | array | 否 | `[]` | 元素数 ≤ 该源 `maxParams`；仅标量 |

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

1. 校验目标源 `allowWrite`（未开启 → `WRITE_DISABLED`）
2. `BEGIN`
3. 执行参数化语句
4. 读取影响行数（`affectedRows`）
5. 若 `affectedRows > 该源 maxAffectedRows`（默认 1000）→ `ROLLBACK`，返回 `RESULT_LIMIT`
6. 否则 `COMMIT`

`maxAffectedRows` 与 `queryTimeoutMs` 均取**目标数据源**合并配置。任何异常 → `ROLLBACK`，返回对应错误码（连接/超时/策略等）。**绝不部分提交**。

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

部署时**必须**创建账号并按模式授权。推荐命名建议只读 `mysql_mcp_ro`、可写 `mysql_mcp_rw`（仅写入数据源使用）。

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

### 7.2 受控写账号（仅写入数据源使用）

```sql
CREATE USER 'mysql_mcp_rw'@'%' IDENTIFIED BY '<强密码>';
GRANT SELECT, SHOW VIEW ON `app`.* TO 'mysql_mcp_rw'@'%';
GRANT INSERT, UPDATE, DELETE ON `app`.* TO 'mysql_mcp_rw'@'%';
FLUSH PRIVILEGES;
```

在只读账号基础上追加受控 DML，**保持其它权限一律禁用**（尤其 `FILE`、`PROCESS`、DDL、`GRANT`）。

### 7.3 每源 `allowWrite` 维度

写入能力已从“全局唯一开关”细化为**每数据源可选**（`allowWrite`），账号授权需与各源的 `allowWrite` 对齐：

| 数据源 `allowWrite` | 建议账号 | `mysql_execute` 行为 |
| --- | --- | --- |
| `false`（缺省） | 只读账号 `mysql_mcp_ro` | 调用返回 `WRITE_DISABLED` |
| `true` | 受控写账号 `mysql_mcp_rw` | 允许受控 DML，事务化执行 |

同一配置文件中，各 source 可独立选择只读或可写账号；只读源使用低权限账号，可写源仅在其 `allowWrite=true` 时才配 `mysql_mcp_rw`。

### 7.4 账号授权原则

1. **最小权限**：只授予目标业务库，不授予 `*.*`。
2. **写账号分离**：可写账号仅在对应数据源 `allowWrite=true` 时使用，并同样限制库范围。
3. **禁止**：`FILE`、`PROCESS`、用户管理、DDL 权限，以及生产环境使用高权限 `root` 接入。
4. **只读账号先行**：默认（`allowWrite=false`）数据源必须使用只读账号；不要因为只读模式就把写入权限误授。
5. 生产环境连接走 TLS，并设置强密码（不落文档、不进日志；密码经 `${VAR}` 环境变量引用传入，明文仅存内存）。

## 8. 安全边界汇总（纵深防御）

| 层级 | 机制 |
| --- | --- |
| 传输/协议 | stdio 专用、stdout 仅协议帧、日志走 stderr |
| 配置 | JSON 文件声明多源（`MCP_SOURCES_FILE`）、fail-fast、目标/默认源校验；密码经 `${VAR}` 引用且不记日志 |
| 参数校验 | Schema（`additionalProperties:false`）、长度/数量/范围上限、每源限制项 |
| SQL 策略 | AST 分类 + 危险特征 + 多语句/注释处理 + 黑名单 |
| 工具隔离 | 只读/写入能力按**每数据源 `allowWrite`** 隔离；写入工具恒定注册但按源判定 |
| 执行限制 | 查询超时、最大行数截断、写入影响行数上限、事务回滚 |
| 数据库权限 | 最小权限账号兜底（真正安全边界） |
| 日志脱敏 | 密码（含 `${VAR}` 展开明文）/完整 SQL 不落日志、关联 ID 排查 |
