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

### 2.1 多数据源配置解析（`loadSourcesConfig`）

| 用例 | 输入 | 期望结果 |
| --- | --- | --- |
| 全部有效 | 合法 JSON（global + 多 source） | 解析成功，默认值正确 |
| 最小配置 | 仅 `sources` 必填字段，无 global | global 用默认值；`defaultTarget` 取首 source |
| 密码缺失 | 某 source 未设 `password` | fail-fast，`CONFIG_INVALID` |
| 密码 `${VAR}` 引用 | `"password": "${MYSQL_PASSWORD}"` | 展开为环境变量值；变量缺失或为空 fail-fast |
| `defaultTarget` 非法 | 指向不存在 source | fail-fast |
| target 规则 | 空/超 64 字符/非法字符/重复 | fail-fast |
| 全局专属放 source 内 | source 含 `poolSize`/`poolIdleTimeoutMs`/`logLevel` | fail-fast |
| 连接参数放 global | `global.host` 等 | fail-fast |
| 端口越界 | `port=0` 或 `70000` | fail-fast |
| 布尔非标准 | `tls=1` / `yes` / `on` | fail-fast（拒绝 `1/yes/no`） |
| 布尔大小写 | `allowWrite=True` | 解析为 true |
| 数值越界 | `maxRows=0` / `20000` | fail-fast |
| 数值非数字 | `poolSize=abc` | fail-fast |
| 时间单位 | `queryTimeoutMs=50` | fail-fast（低于 100） |
| 日志级别非法 | `logLevel=verbose` | fail-fast |
| 三层合并 | source 显式值 / global 值 / 内置默认 | 合并顺序 source > global > 默认 |

### 2.2 registry / `ConnectionManager` 矩阵

| 用例 | 输入 | 期望结果 |
| --- | --- | --- |
| 恒注册 5 工具 | 任意配置启动后 `tools/list` | 恒含 `mysql_execute` 共 5 工具 |
| 未知 target | `target="ghost"` 调用任意工具 | `PARAM`，`details.target=ghost` |
| `configFor` 缺省 | `configFor()` 无参 | 返回 `defaultTarget` 源配置 |
| `resolve` 缺省 | `resolve()` 无参 | 落到默认源执行器 |
| 懒建每源池 | 依次访问多 target | 每个 target 首次访问才建池，复用 |
| `endAll` 收敛 | 关闭时 | 全部已建池关闭、无泄漏 |

### 2.3 target 分派矩阵

| 用例 | 输入 | 期望结果 |
| --- | --- | --- |
| 只读按源限制 | `target=replica`（`maxRows=2000`）执行 `mysql_query` 超 1000 行 | 按该源上限截断 |
| 写入按源开关 | `target=readonly` 调 `mysql_execute` | `WRITE_DISABLED` |
| 写入按源上限 | `target=write-pool`（`maxAffectedRows=500`）超上限 | `RESULT_LIMIT` 且回滚 |
| 每源 `sqlMaxLength` | 超该源 `sqlMaxLength` | `PARAM`，details 带源上限 |
| 双层校验（query） | 注册期全局默认通过、运行期某源上限更小 | 运行期按源二次校验返回 `PARAM` |

### 2.4 SQL 分类器

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
| 影响行数超限 | `affectedRows > 该源 maxAffectedRows` | `RESULT_LIMIT`，且事务回滚 |

## 4. 集成测试

**前置**：可用 MySQL（Docker 时 `docker run` 起 MySQL 8.x），准备两套账号（只读 `mysql_mcp_ro`、可写 `mysql_mcp_rw`），并准备一个写入未开启源与一个写入开启源。

| 用例 | 账号 | 场景 | 期望 |
| --- | --- | --- | --- |
| 只读查询 | ro | `SELECT` 正常 | 返回正确行 |
| 只读误写 | ro | 调用 `INSERT` | 应用层 `POLICY_REJECTED`（若绕过）→ 数据库权限拒绝 |
| 元数据 | ro | `list_databases`/`list_tables`/`describe_table` | 返回可见列表 |
| 写入未开启源 | ro | 对 `allowWrite=false` 源调 `mysql_execute` | `WRITE_DISABLED` |
| 写入开启源 | rw | 对 `allowWrite=true` 源 `INSERT`/带`WHERE` `UPDATE`/`DELETE` | 事务提交、返回行数正确 |
| 写入超上限 | rw | `affectedRows` 超该源 `maxAffectedRows` | 回滚、无副作用残留 |
| 写入异常 | rw | 中途报错 | 回滚、返回对应错误码 |

## 5. MCP 协议测试

| 用例 | 场景 | 期望 |
| --- | --- | --- |
| 初始化握手 | 发 `initialize` | 成功返回协议版本、能力、工具列表 |
| 工具列表-恒 5 工具 | 任意配置 `tools/list` | 恒含 `mysql_execute`，共 5 个工具 |
| 写入按源判定 | 对 `allowWrite=false` 源调 `mysql_execute` | `WRITE_DISABLED`；工具列表仍含 `mysql_execute` |
| 写入开关不可动态 | 运行期尝试打开写入 | 无对应机制，按源 `allowWrite` 不变 |
| 未知 target | 传 `target=ghost` | `PARAM` 错误 |
| stdout 纯净 | 启动 + 多工具调用 | `stdout` 仅有效 MCP 帧，无日志/无诊断 |
| 日志走 stderr | 任意调用 + 出错 | 脱敏日志仅在 `stderr` 出现 |
| 进程退出清理 | 发 `SIGINT`/`SIGTERM` | `ConnectionManager.endAll()` 被调用，进程正常退出 |
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

> **当前状态**：M0–M4 已完成——多数据源改造（JSON 多源配置、`ConnectionManager` 按 target 懒建多池、`mysql_execute` 常注册 + 按源 `allowWrite`）已通过 typecheck 与全部单元测试。

### M0 —— 设计冻结（已完成）

- **交付**：README + 三份设计文档（本仓库当前为第 4 份，共 4 份文档）。
- **退出条件**：设计文档评审通过；工具/配置/错误码跨文档一致；多源配置与按源写入判定逻辑明确。

### M1 —— 协议骨架与配置

- **交付**：Node/TS 工程、入口 `main`、SDK Server、stdio transport、`loadSourcesConfig` 多源解析与 fail-fast。
- **退出条件**：单元测试（多源配置矩阵）全绿；能握手、`tools/list` 返回（暂无需 SQL）。

### M2 —— 只读能力

- **交付**：`ConnectionManager` + 每源连接池、元数据服务、`mysql_query`、序列化、错误映射、日志脱敏。
- **退出条件**：只读工具可用（含多源 target 分派）；集成 + 协议测试通过；`stdout` 纯净。

### M3 —— 受控写入

- **交付**：`mysql_execute` 常注册 + 按源 `allowWrite` 判定、SQL 写入策略、事务化执行、影响行数上限回滚、只读/写账号分离。
- **退出条件**：安全回归用例（S 类）全绿；按源开启/关闭写入行为正确。

### M4 —— 发布准备

- **交付**：打包脚本、`README` 快速开始实化（多源示例）、文档定稿、示例配置/授权脚本。
- **退出条件**：全部测试通过；Gitee `main` 默认分支、文档与实现仓库一致、无敏感信息泄漏。

## 8. 一致性承诺

- 本仓库所有文档与后续实现必须遵守 [架构·配置体系](architecture.md#5-配置体系) 的默认值与 [工具契约](tool-contracts-and-security.md) 的 Schema。
- 任何一处修改默认值/错误码/工具名，须同步更新三份设计文档并在测试矩阵补用例。
- 安全回归测试（第 6 节）为发布门槛，任何实现不得以“测试难写”为由跳过。
