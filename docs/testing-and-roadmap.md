# MySQL MCP Tool 测试矩阵与实施路线

本文档定义 MySQL MCP 服务的测试策略（单元/集成/安全回归）以及 M0–M4 实施阶段的验收标准。所有术语、工具名、配置名、默认值、错误码与 [架构设计](architecture.md)、[工具契约与安全设计](tool-contracts-and-security.md) 保持一致。

## 1. 测试层次总览

| 层次 | 目标 | 依赖 | 速度 |
| --- | --- | --- | --- |
| 单元测试 | 配置/分类/错误映射/序列化/限制逻辑 | 无外部依赖（Mock 驱动） | 快 |
| 集成测试 | 只读与可写账号行为 | 真实 MySQL（可 Docker） | 中 |
| MCP 协议测试 | 初始化、工具注册、stdout 纯净、退出清理 | 模拟 stdio 客户端 | 中 |
| 安全回归测试 | 拒绝跳过的攻击样例 | 真实 MySQL + 低权限账号 | 中 |

## 2. 单元测试矩阵

### 2.1 配置解析（Config）

| 用例 | 输入 | 期望结果 |
| --- | --- | --- |
| 全部有效 | 合法环境变量 | 解析成功，默认值正确 |
| 密码缺失 | 未设 `MYSQL_PASSWORD` | fail-fast，`CONFIG_INVALID` |
| 端口越界 | `MYSQL_PORT=0` 或 `70000` | fail-fast |
| 布尔非标准 | `MYSQL_TLS=1` / `yes` / `on` | fail-fast（拒绝 `1/yes/no`） |
| 布尔大小写 | `MYSQL_ALLOW_WRITE=True` | 解析为 true |
| 数值越界 | `MYSQL_MAX_ROWS=0` / `20000` | fail-fast |
| 数值非数字 | `MYSQL_POOL_SIZE=abc` | fail-fast |
| 时间单位 | `MYSQL_QUERY_TIMEOUT_MS=50` | fail-fast（低于 100） |
| 日志级别非法 | `MYSQL_LOG_LEVEL=verbose` | fail-fast |

### 2.2 SQL 分类器

| 用例 | 输入 | 期望分类/判定 |
| --- | --- | --- |
| 纯只读 | `SELECT a FROM t WHERE id=?` | ✅ query 允许 |
| CTE 只读 | `WITH c AS (SELECT 1) SELECT * FROM c` | ✅ query 允许 |
| 大小写 | `sElEcT * FrOm t` | ✅（大小写不敏感） |
| 多余空白 | `SELECT\n * FROM\tt` | ✅（空白不敏感） |
| 注释 | `-- hi\nSELECT * FROM t`、`/*x*/ SELECT 1` | ✅（剥离后分类） |
| 版本注释 | `/*!50000 SELECT 1 */` | ✅（内容仍被分类） |
| 锁定读取 | `SELECT ... FOR UPDATE` | ⛔ query 拒绝 |
| 文件输出 | `SELECT ... INTO OUTFILE ...` | ⛔ 拒绝 |
| 用户变量副作用 | `SELECT @x := 1` | ⛔ 拒绝 |
| 危险函数 | `SELECT SLEEP(10)`、`SELECT BENCHMARK(...)` | ⛔ 拒绝（黑名单） |
| 多语句 | `SELECT 1; DROP TABLE t` | ⛔ 拒绝（多语句） |
| 无条件更新 | `UPDATE t SET a=1` | ⛔ execute 拒绝 |
| 带 WHERE 更新 | `UPDATE t SET a=? WHERE id=?` | ✅ execute 允许 |
| 无条件删除 | `DELETE FROM t` | ⛔ execute 拒绝 |
| INSERT VALUES | `INSERT INTO t (a) VALUES (?)` | ✅ execute 允许 |
| INSERT SELECT | `INSERT INTO a SELECT * FROM b` | ⛔ execute 拒绝 |
| REPLACE | `REPLACE INTO t VALUES (1)` | ⛔ 拒绝 |
| upsert | `INSERT ... ON DUPLICATE KEY UPDATE ...` | ⛔ 拒绝 |
| 多表写入 | `UPDATE a JOIN b ...` | ⛔ 拒绝 |
| DDL | `DROP TABLE t`、`ALTER TABLE ...` | ⛔ 拒绝 |
| DCL | `GRANT SELECT ...` | ⛔ 拒绝 |
| TCL | `BEGIN` / `COMMIT` / `ROLLBACK` | ⛔ 拒绝 |
| CALL | `CALL p()` | ⛔ 拒绝 |
| PREPARE/EXECUTE | `PREPARE s FROM ...` | ⛔ 拒绝 |
| 解析失败 | 语法非法/截断文本 | ⛔ 拒绝（`POLICY_REJECTED`） |

## 3. 序列化与限制逻辑测试

| 用例 | 输入 | 期望结果 |
| --- | --- | --- |
| BIGINT 保精度 | `9223372036854775807` | 返回字符串 `"9223372036854775807"` |
| DECIMAL 保精度 | `1234.567890123456` | 返回字符串 |
| DATETIME | 服务器本地时区值 | 返回 MySQL 原样字符串 |
| 二进制 | `0x00FF` | base64 字符串 |
| BIT | `b'1010'` | 字符串 `"1010"` |
| NULL | NULL 列 | JSON `null` |
| JSON 字段 | `{"a":1}` | 原样 JSON 文本 |
| 行数截断 | 结果 > `maxRows` | `truncated:true` + 仅前 `maxRows` 行 |
| 影响行数超限 | `affectedRows > MYSQL_MAX_AFFECTED_ROWS` | `RESULT_LIMIT`，且事务回滚 |

## 4. 集成测试

**前置**：可用 MySQL（Docker 时 `docker run` 起 MySQL 8.x），准备两套账号。

| 用例 | 账号 | 场景 | 期望 |
| --- | --- | --- | --- |
| 只读查询 | ro | `SELECT` 正常 | 返回正确行 |
| 只读误写 | ro | 调用 `INSERT` | 应用层 `POLICY_REJECTED`（若绕过）→ 数据库权限拒绝 |
| 元数据 | ro | `list_databases`/`list_tables`/`describe_table` | 返回可见列表 |
| 写入默认关闭 | ro/rw | 未开 `MYSQL_ALLOW_WRITE`，工具列表 | 不含 `mysql_execute` |
| 写入开启 | rw | `MYSQL_ALLOW_WRITE=true`，`INSERT`/带`WHERE` `UPDATE`/`DELETE` | 事务提交、返回行数正确 |
| 写入超上限 | rw | `affectedRows` 超 `MYSQL_MAX_AFFECTED_ROWS` | 回滚、无副作用残留 |
| 写入异常 | rw | 中途报错 | 回滚、返回对应错误码 |

## 5. MCP 协议测试

| 用例 | 场景 | 期望 |
| --- | --- | --- |
| 初始化握手 | 发 `initialize` | 成功返回协议版本、能力、工具列表 |
| 工具列表-默认 | 默认模式 `tools/list` | 仅 4 个只读工具 |
| 工具列表-开启 | 开启写入 `tools/list` | 含 `mysql_execute` |
| 条件注册不可动态 | 运行期尝试打开写入 | 无对应机制，工具不变 |
| stdout 纯净 | 启动 + 多工具调用 | `stdout` 仅有效 MCP 帧，无日志/无诊断 |
| 日志走 stderr | 任意调用 + 出错 | 脱敏日志仅在 `stderr` 出现 |
| 进程退出清理 | 发 `SIGINT`/`SIGTERM` | `pool.end()` 被调用，进程正常退出 |
| 异常退出 | 未捕获异常 | 清理并退出，无资源泄漏 |

## 6. 安全回归测试（重点）

| 编号 | 攻击/绕过 | 期望结果 |
| --- | --- | --- |
| S1 多语句注入 | `SELECT 1; DROP TABLE t` | 拒绝，表未删除 |
| S2 注释绕过 | `SELECT 1 --` + 第二语句藏注释后 | 拒绝 |
| S3 版本注释绕过 | `/*!50000 SELECT ... INTO OUTFILE ... */` | 拒绝 |
| S4 锁定读取 | `SELECT ... FOR UPDATE` | query 拒绝 |
| S5 文件输出 | `SELECT ... INTO OUTFILE` | 拒绝 |
| S6 无条件写入 | `UPDATE t SET a=1` | execute 拒绝 |
| S7 多表写入 | `UPDATE a JOIN b ...` | 拒绝 |
| S8 敏感信息泄漏 | 语句报错/日志 | 日志不含密码与完整 SQL 正文 |
| S9 大爆炸查询 | 超长 SQL / 海量参数 | `PARAM` 或长度上限拒绝 |
| S10 凭据注入入参 | `params` 传连接串/换行 | 仅作绑定值，不改变连接/语义 |
| S11 危险函数 | `SELECT SLEEP(100)` | 黑名单拒绝 |
| S12 用户变量副作用 | `SELECT @x := 1` | 拒绝 |
| S13 跨库自由访问 | 未授权库查询 | 数据库权限拒绝 |
| S14 超时保护 | 长查询 > `timeoutMs` | `TIMEOUT` 错误、连接释放 |

## 7. 实施路线（M0–M4）

### M0 —— 设计冻结（当前）

- **交付**：README + 三份设计文档（本仓库当前为第 4 份，共 4 份文档）。
- **退出条件**：设计文档评审通过；工具/配置/错误码跨文档一致；默认只读与条件注册逻辑明确。

### M1 —— 协议骨架与配置

- **交付**：Node/TS 工程、入口 `main`、SDK Server、stdio transport、Config 解析与 fail-fast。
- **退出条件**：单元测试（配置矩阵）全绿；能握手、`tools/list` 返回（暂无需 SQL）。

### M2 —— 只读能力

- **交付**：连接池、元数据服务、`mysql_query`、序列化、错误映射、日志脱敏。
- **退出条件**：只读 4 工具可用；集成 + 协议测试通过；`stdout` 纯净。

### M3 —— 受控写入

- **交付**：`mysql_execute` 条件注册、SQL 写入策略、事务化执行、影响行数上限回滚、只读/写账号分离。
- **退出条件**：安全回归用例（S 类）全绿；开启/关闭写入行为正确。

### M4 —— 发布准备

- **交付**：打包脚本、`README` 快速开始实化、文档定稿、示例配置/授权脚本。
- **退出条件**：全部测试通过；Gitee `main` 默认分支、文档与实现仓库一致、无敏感信息泄漏。

## 8. 一致性承诺

- 本仓库所有文档与后续实现必须遵守 [架构·配置体系](architecture.md#5-配置体系) 的默认值与 [工具契约](tool-contracts-and-security.md) 的 Schema。
- 任何一处修改默认值/错误码/工具名，须同步更新三份设计文档并在测试矩阵补用例。
- 安全回归测试（第 6 节）为发布门槛，任何实现不得以“测试难写”为由跳过。
