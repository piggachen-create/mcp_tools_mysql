# MySQL MCP Tool 架构设计

本文档描述 MySQL MCP 服务的整体架构、请求调用链、模块边界、连接池生命周期、配置体系与错误码模型。所有术语、工具名、配置名、默认值、错误码均与 [工具契约与安全设计](tool-contracts-and-security.md)、[测试矩阵与实施路线](testing-and-roadmap.md) 保持一致。

## 1. 总体架构

MCP 服务运行在 AI 客户端（如 Claude Desktop、Cursor 等）的子进程中，通过 `stdio` 与客户端交换 JSON-RPC 帧。服务在 `stdout` 输出协议数据，在 `stderr` 输出脱敏日志。

```
┌────────────────────────────┐        JSON-RPC over stdio
│       MCP 客户端           │ ◄─────────────────────────────►
└────────────────────────────┘
                              │  stdout: 协议帧 /  stderr: 脱敏日志
                              ▼
┌────────────────────────────────────────────────────────────┐
│                    MCP Server (mysql-mcp-tool)             │
│                                                            │
│  ┌──────────┐   ┌──────────┐   ┌────────────┐   ┌────────┐ │
│  │ 入口 main │──►│ Server   │──►│ 工具注册表  │──►│ 安全策略│ │
│  └──────────┘   │ (MCP SDK)│   └────────────┘   └────────┘ │
│                 └──────────┘         │                     │
│                          ┌───────────▼──────────┐         │
│                          │   工具处理器 (5)      │         │
│                          │ list_databases       │         │
│                          │ list_tables          │         │
│                          │ describe_table       │         │
│                          │ query                │         │
│                          │ execute (常注册)      │         │
│                          └───────────┬──────────┘         │
│                                      │                    │
│              ┌───────────────────────┼─────────────┐      │
│              ▼                       ▼             ▼      │
│        ┌───────────┐          ┌────────────┐  ┌──────────┐│
│        │  元数据    │          │ SQL 解析/    │  │ 序列化   ││
│        │  服务      │          │ 分类器      │  └──────────┘│
│        └─────┬─────┘          └────────────┘              │
│              ▼                                            │
│        ┌─────────────────────────────────────────────────┐│
│        │   ConnectionManager（按 target 懒建多源池）        ││
│        └─────────────────────────┬───────────────────────┘│
│                                  ▼                        │
│                    ┌──────────────────────────┐           │
│                    │  MySQL 连接池(每源 mysql2) │           │
│                    └──────────────────────────┘           │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     MySQL 服务器（低权限账号）
```

## 2. 模块边界

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| **入口 `main`** | 解析环境与启动参数、构造 Server、绑定 stdio transport、注册生命周期钩子 | 业务逻辑、SQL 校验 |
| **配置 `loadSourcesConfig`** | 从 JSON 文件（`MCP_SOURCES_FILE` 指定路径）读取并校验多数据源配置，产出 `SourcesConfig`；展开密码环境变量引用 | I/O、SQL 执行 |
| **Server** | 基于 MCP TS SDK 管理工具注册、请求派发、初始化握手 | SQL 语义判断 |
| **工具注册表** | 恒定注册 5 个工具（含 `mysql_execute`）；运行期 handler 内按各数据源 `allowWrite` 判定写入可用性 | 运行期动态改工具集 |
| **连接管理 `ConnectionManager`** | 按 target 懒建并复用多个单源 `MysqlPool`；解析目标源、按 target 分派只读/写执行器；调用 `endAll` 收敛全部池 | SQL 语义判断、序列化 |
| **连接池 `MysqlPool`** | 针对单个已合并数据源配置创建/复用/销毁连接到该数据源的池，控制并发上限 | 连接多数据源、跨源分派 |
| **元数据服务** | 封装 `list_databases` / `list_tables` / `describe_table` 所需的信息型查询 | 业务查询 |
| **SQL 分类器** | 通过 AST 解析对语句分类并做危险特征检查（只读 vs 写入、是否允许） | 实际执行 |
| **安全策略** | 校验参数、限制行数/超时/影响行数、拒绝名单、写入开关 | SQL 语法解析 |
| **序列化** | 将 MySQL 行数据转为 JSON，处理大数值/时间/二进制/`NULL` | 类型判断之外的行为 |
| **错误映射** | 将内部异常映射为稳定错误码与脱敏消息 | 直接抛出原始异常 |

## 3. 请求调用链

以 `mysql_query` 为例的只读查询链路：

```
客户端 ──(invoke mysql_query)──► Server ──► 安全策略(参数/超时/行数校验)
        ──► SQL 分类器(AST 分类 + 危险特征) ──► 策略判定(SELECT 允许)
        ──► Pool.getConnection ──► execute(参数化) ──► 序列化行数据
        ──► 结果(列元数据+行+截断标识+耗时) ──► Server ──► 客户端
```

以 `mysql_execute` 为例的受控写入链路（目标源 `allowWrite` 开启时可用）：

```
客户端 ──(invoke mysql_execute)──► Server
        ──► 目标源 allowWrite 检查(未开启→WRITE_DISABLED)
        ──► SQL 分类器(AST 分类) ──► 策略判定(仅 INSERT / 带 WHERE 的 UPDATE|DELETE)
        ──► BEGIN ──► 执行 ──► 影响行数 ≤ 上限? ├─ 是 ──► COMMIT
                                              └─ 否 ──► ROLLBACK
        ──► 结果(影响行数/变更行数/插入ID/耗时) ──► 客户端
```

## 4. 连接池生命周期

- **多数据源**：一个进程可声明多个 MySQL 数据源（由目标 `target` 标识区分）。`ConnectionManager` 按 target **懒建并复用**对应数据源的 `MysqlPool`；池参数（`poolSize` / `poolIdleTimeoutMs`）取自进程级 `global` 配置，经构造注入所有池。
- **默认源**：未显式指定 target 的工具调用落到 `defaultTarget`（缺省取首 source）；未知 target 返回 `PARAM`。
- **懒连接**：首次访问某 target 时才创建该源池，启动阶段不强制验证连通性（避免占空资源）；未访问的数据源不建立任何连接。工具首次执行失败时返回 `CONNECTION`。
- **池参数**：`poolSize` 与 `poolIdleTimeoutMs` 由 `global` 配置控制，见下文配置体系。
- **进程退出清理**：注册 `SIGINT` / `SIGTERM` / `exit` / `uncaughtException` / `unhandledRejection` 钩子，调用 `ConnectionManager.endAll()` 遍历并发关闭全部数据源池；关闭完成后进程退出。退出清理日志写入 `stderr`。
- **异常处理**：连接获取失败、执行中断、查询超时均映射为稳定错误码；不做隐式重试连接（由调用方决定是否重试）。

## 5. 配置体系

配置由**单个 JSON 文件**声明多数据源，路径由环境变量 `MCP_SOURCES_FILE` 指定（缺省 `./mcp.sources.json`）。服务启动时完整解析并校验（`loadSourcesConfig()`），任一配置不合法则**直接失败退出**（fail-fast）。首版不再使用平铺 `MYSQL_HOST` 等环境变量作为连接来源（仅密码支持 `${VAR}` 引用）；旧的平铺环境变量清单已废弃。

### 5.0 文件入口与目标（target）

- **文件路径**：`MCP_SOURCES_FILE`，缺省 `./mcp.sources.json`。
- **`target` 规则**：非空、1–64 字符、字符集 `[a-zA-Z0-9_-]`、全局唯一。
- **`defaultTarget`**：可选，声明默认目标源（必须指向已存在 target）；缺省取首个 source。工具未显式指定 target 时落到默认源。
- **密码环境变量引用**：密码字段支持书写 `${VAR}`（如 `${MYSQL_PASSWORD}`），启动时整体替换为对应环境变量值；展开后明文仅存内存，**禁止写入任何日志**。

示例配置文件架构：

```json
{
  "global": { ... },
  "defaultTarget": "app",
  "sources": [ { "target": "app", ... }, ... ]
}
```

### 5.1 类型与字段分类

- **`GlobalConfig`**：`poolSize` / `poolIdleTimeoutMs` / `logLevel` / `defaultTarget`（进程级全局）。
- **`DatasourceConfig`**：`target` + 连接参数 + 可覆盖控制项（原单源 `Config` 类型已更名）。
- **`SourcesConfig`**：`global` + `sources` 数组。

字段按以下三类管理：

| 分类 | 字段 | 位置约束 |
| --- | --- | --- |
| **全局专属**（只放 `global`） | `poolSize`、`poolIdleTimeoutMs`、`logLevel` | 放 source 内 fail-fast |
| **可覆盖**（三层合并 source > global > 内置默认） | `queryTimeoutMs`、`maxRows`、`maxAffectedRows`、`sqlMaxLength`、`maxParams`、`allowWrite`、`tls`、`tlsRejectUnauthorized`、`connectTimeoutMs` | source 与 global 均可用 |
| **连接参数**（source 必填，不得放 `global`） | `host`、`port`、`user`、`password`、`database`、`charset`、`target` | 仅出现在 source 内；出现在 global 内 fail-fast |

### 5.2 连接参数（每源）

| 配置项 | 必填 | 默认值 | 合法范围/格式 | 启动失败条件 | 敏感等级 | 允许日志 |
| --- | --- | --- | --- | --- | --- | --- |
| `target` | 是 | 无 | 非空，1–64，`[a-zA-Z0-9_-]` | 缺失/空/超长/非法字符/重复 | 低 | 是 |
| 主机 `host` | 是 | 无 | 非空字符串，DNS/IPv4/IPv6/主机名 | 缺失或为空 | 低 | 是 |
| 端口 `port` | 否 | `3306` | 整数 1–65535 | 非整数或越界 | 低 | 是 |
| 用户名 `user` | 是 | 无 | 非空字符串 | 缺失或为空 | 中 | 否 |
| 密码 `password` | 是 | 无 | 任意字符串，支持 `${VAR}` 引用 | 缺失或为空 / 引用变量缺失或为空 | 高 | **否（任何日志均禁止）** |
| 数据库 `database` | 否 | 空 | 非空字符串；为空时使用账号默认库 | 无 | 中 | 是 |
| 字符集 `charset` | 否 | `utf8mb4` | 合法字符集名 | 非法字符集 | 低 | 是 |

### 5.3 可覆盖控制项（全局默认 + 每源覆盖）

| 配置项 | 内置默认 | 合法范围/格式 | 启动失败条件 | 敏感等级 | 允许日志 |
| --- | --- | --- | --- | --- | --- |
| 连接超时(ms) `connectTimeoutMs` | `10000` | 整数 100–600000 | 越界 | 低 | 是 |
| 查询超时(ms) `queryTimeoutMs` | `30000` | 整数 100–300000(见下) | 越界 | 低 | 是 |
| 最大返回行数 `maxRows` | `1000` | 整数 1–10000 | 越界 | 低 | 是 |
| SQL 最大长度 `sqlMaxLength` | `16384` | 整数 1–1048576 | 越界 | 低 | 是 |
| 参数最大个数 `maxParams` | `500` | 整数 0–10000 | 越界 | 低 | 是 |
| 最大影响行数 `maxAffectedRows` | `1000` | 整数 1–100000 | 越界 | 低 | 是 |
| 启用 TLS `tls` | `false` | `true`/`false` | 值不合法 | 低 | 是 |
| TLS 拒绝非受信证书 `tlsRejectUnauthorized` | `true` | `true`/`false` | 值不合法 | 低 | 是 |
| 启用受控写入 `allowWrite` | `false` | `true`/`false` | 值不合法 | 中 | 是 |

### 5.4 全局专属字段

| 配置项 | 默认值 | 合法范围/格式 | 启动失败条件 |
| --- | --- | --- | --- |
| 连接池大小 `poolSize` | `5` | 整数 1–100 | 越界 |
| 池空闲回收(ms) `poolIdleTimeoutMs` | `60000` | 整数 0–3600000；0=禁用 | 越界 |
| 日志级别 `logLevel` | `info` | `debug`/`info`/`warn`/`error`/`silent` | 值不合法 |

### 5.5 合并规则

每源最终配置 = **source 显式值 > global 值 > 内置默认**（三层合并）。连接参数不参与合并，source 内必填。

**配置校验通用规则**

- **布尔值只接受 `true`/`false`**（大小写不敏感，并兼容 JSON 布尔）；`1`、`0`、`yes`、`no`、`on`、`off` 均视为非法并拒绝启动。
- **数值必须做上下界校验**；解析失败（非数字）或越界直接 fail-fast。
- 所有 `*_MS` 均为毫秒整数，不做浮点。
- `queryTimeoutMs` 上限 300000（5 分钟）防误设；单次工具可传入更小的 `timeoutMs`，但不能超过该源服务上限，见工具契约。
- 配置不合法时启动即失败，错误仅含配置项名、不含值（脱敏）。

> **废弃说明**：首版平铺环境变量清单（`MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_PORT` / `MYSQL_DATABASE` / `MYSQL_ALLOW_WRITE` 等）已不再作为连接参数来源，此清单废弃。仅 `MCP_SOURCES_FILE` 保留作为配置文件路径入口，密码经 `${VAR}` 引用传入。

## 6. 日志与脱敏

- **stderr 专用**：所有日志写入 `stderr`；`stdout` 严禁输出任何非协议内容。
- **脱敏规则**：日志中密码字段一律被 `********` 替换（含经 `${VAR}` 展开后的明文密码——展开后仅存内存，禁入任何日志）；用户名可记录；SQL 文本仅记录语句**分类结果与校验拒绝原因**，不记录完整 SQL 正文（避免泄露表结构或敏感查询）。
- **关联 ID**：每次工具调用分配递增请求 ID，形如 `req-<n>`，在日志与错误响应中一致出现，便于排查。
- 错误响应通过 `isError: true` 返回，`details` 字段仅保留脱敏信息；原始异常栈只进日志，不进客户端响应。

## 7. 错误码模型

| 错误码 | 名称 | 客户端消息（脱敏后） | 可重试 | 脱敏 details | 日志关联 |
| --- | --- | --- | --- | --- | --- |
| `CONFIG_INVALID` | 配置非法 | 服务启动配置不合法 | 否 | 失败配置项名（不含值） | `req-<n>` |
| `CONNECTION` | 连接失败 | 无法连接到 MySQL | 是 | 无 | `req-<n>` |
| `TIMEOUT` | 执行超时 | 查询/写入超过时限 | 是 | 实际/设置超时值 | `req-<n>` |
| `PARAM` | 参数非法 | 工具入参不符合 Schema | 否 | 字段名与错误概要 | `req-<n>` |
| `POLICY_REJECTED` | 策略拒绝 | 该操作不在允许范围内 | 否 | 拒绝原因（分类/特征） | `req-<n>` |
| `WRITE_DISABLED` | 写入关闭 | 写入能力未开启 | 否 | 无 | `req-<n>` |
| `RESULT_LIMIT` | 结果超限 | 返回/影响结果超过上限 | 否 | 触发的上限类型与值 | `req-<n>` |
| `SERIALIZE` | 序列化失败 | 结果无法序列化 | 否 | 字段名 | `req-<n>` |
| `INTERNAL` | 内部错误 | 服务内部错误 | 否 | 无（仅日志含栈） | `req-<n>` |

所有错误通过 MCP 标准错误响应返回并设置 `isError: true`；客户端消息恒定、可本地化，不泄漏 SQL 正文与凭据。

**多数据源语义**

- **未知 target**：不新增顶层错误码（不设 `SOURCE_NOT_FOUND`），复用 `PARAM`，`details` 携带 `target=...`。
- **写入源未开启**：某数据源 `allowWrite=false` 时调用 `mysql_execute`，复用 `WRITE_DISABLED`（客户端消息“写入能力未开启”）。

## 8. 与其它文档的关系

- 工具输入输出 Schema、SQL 决策表与权限矩阵见 [工具契约与安全设计](tool-contracts-and-security.md)。
- 上述配置与错误码的测试用例、验收标准见 [测试矩阵与实施路线](testing-and-roadmap.md)。
- 能力边界与快速开始见项目 [README](../README.md)。
