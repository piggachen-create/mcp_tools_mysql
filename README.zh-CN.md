# MySQL MCP Tool（中文版）

面向 MySQL 的 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 服务。本服务通过 MCP 协议，让 AI 客户端以统一、受控的方式探查 MySQL 数据库结构并执行只读查询；写入能力按数据源显式开启。

> **当前状态：多数据源版已发布（M4 里程碑完成）**
> 配置由单个 JSON 文件（`MCP_SOURCES_FILE`）声明**多数据源**（含 `global` 全局默认 `+ sources` 每源覆盖合并）；`ConnectionManager` 按 target 懒建并复用每源连接池；5 个工具恒定注册，`mysql_execute` 按目标数据源 `allowWrite` 判定可用性。已完成 typecheck 与全部单元测试。

> **English（默认）**: 本仓库以英文为主，对应手册 [README.md](README.md)；设计文档见 [docs/](docs/)（英文）与 `docs/*.zh-CN.md`（中文）。

---

## 目录

1. [项目概述](#1-项目概述)
2. [环境要求与构建](#2-环境要求与构建)
3. [快速开始](#3-快速开始)
4. [配置参考](#4-配置参考)
5. [工具使用手册](#5-工具使用手册)
6. [错误处理](#6-错误处理)
7. [安全模型](#7-安全模型)
8. [故障排查](#8-故障排查)
9. [打包与发布](#9-打包与发布)
10. [文档导航](#10-文档导航)

---

## 1. 项目概述

### 1.1 它能做什么

- 通过 MCP 工具向 AI 客户端提供 MySQL **元数据读取**（库 / 表 / 字段结构）与**受控的多数据源查询**能力。
- 每个数据源可独立开启**受限写入**；默认全部只读。

### 1.2 技术栈

- Node.js + TypeScript，官方 MCP TypeScript SDK，`mysql2/promise` 驱动。
- **传输方式**：首版仅支持 `stdio` transport，不设计 HTTP/SSE、多租户或管理后台。

### 1.3 多数据源与按源开关

- 一个进程通过 `mcp.sources.json` 声明多个 MySQL 数据源（各以 `target` 标识）。
- 写入能力按**每数据源** `allowWrite` 独立控制；未开启的数据源调用 `mysql_execute` 返回 `WRITE_DISABLED`。

### 1.4 安全边界

- SQL 应用层策略只是纵深防御的第一道；**MySQL 账号权限才是最终安全边界**。服务要求使用低权限数据库账号运行。

### 1.5 可用工具

| 工具 | 说明 | 默认注册 |
| --- | --- | --- |
| `mysql_list_databases` | 列出指定数据源（缺省默认源）账号可见的数据库 | ✅ |
| `mysql_list_tables` | 列出指定 Schema 下的表与视图 | ✅ |
| `mysql_describe_table` | 描述单张表/视图的字段结构 | ✅ |
| `mysql_query` | 执行只读查询（参数化、限行数、限超时） | ✅ |
| `mysql_execute` | 在事务中执行受控 DML（仅 `INSERT`、带 `WHERE` 的 `UPDATE`/`DELETE`）；按目标源 `allowWrite` 判定 | ✅ |

所有工具输入均含可选 `target` 字段：指定数据源标识，缺省落到默认源（`defaultTarget`，缺省取首 source）。

### 1.6 非目标（首版明确不做）

- DDL、DCL、TCL：`CREATE` / `ALTER` / `DROP` / `GRANT` / `BEGIN` / `COMMIT` 等一律拒绝。
- 存储过程 / 函数调用（`CALL`）、多语句批处理。
- 任意数据库切换、事务会话管理、会话级 `USE` 后的跨库自由查询。
- HTTP/SSE、多租户、Web 管理界面、鉴权体系。
- 通过 MCP 请求在运行期动态开启/关闭写入能力。

## 2. 环境要求与构建

### 2.1 环境要求

- **Node.js ≥ 20**（见 `package.json` → `engines`）。

### 2.2 构建与测试

```bash
npm install        # 安装依赖
npm run typecheck  # 仅类型检查（tsc --noEmit）
npm test           # 运行单元测试（vitest）
npm run build      # clean + 编译到 dist/
npm start          # 运行 dist/index.js（stdio 模式）
```

## 3. 快速开始

### 步骤 1 —— 准备低权限数据库账号

服务要求使用低权限账号运行（数据库权限是最终安全边界）：

- **只读数据源**（`allowWrite=false`）：执行 [examples/grant-ro.sql](examples/grant-ro.sql)
- **写入数据源**（对应 `allowWrite=true`）：执行 [examples/grant-rw.sql](examples/grant-rw.sql)

### 步骤 2 —— 编写多数据源配置（mcp.sources.json）

配置由单个 JSON 文件声明，路径由环境变量 `MCP_SOURCES_FILE` 指定（缺省 `./mcp.sources.json`）。顶层结构：`{ global?, defaultTarget?, sources: [...] }`。

最简单源配置：

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

完整多源示例（全局默认 + 每源覆盖 + 一个可写源）：

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

### 步骤 3 —— 接入 MCP 客户端（stdio）

将服务作为子进程拉起，并通过 `MCP_SOURCES_FILE` 指定配置文件路径。示例（Claude Desktop 的 `claude_desktop_config.json` 或 Cursor 的 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["/absolute/path/to/mysql-mcp-tool/dist/index.js"],
      "env": {
        "MCP_SOURCES_FILE": "/absolute/path/to/mysql-mcp-tool/examples/mcp.sources.json",
        "MYSQL_PASSWORD": "<强密码>",
        "MYSQL_REPLICA_PASSWORD": "<副本强密码>",
        "MYSQL_WRITE_PASSWORD": "<写入账号强密码>"
      }
    }
  }
}
```

> **`target` 说明**：每个工具都接受可选 `target` 字段指定数据源，缺省落到 `defaultTarget`（例中为 `app`）。例如 `"target": "write-pool"` 即对该可写源执行受控 DML。

## 4. 配置参考

### 4.1 环境变量

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MCP_SOURCES_FILE` | 否 | `./mcp.sources.json` | 多数据源 JSON 配置文件路径 |

### 4.2 字段归属

| 分类 | 字段 | 位置约束 |
| --- | --- | --- |
| **全局专属** | `poolSize`、`poolIdleTimeoutMs`、`logLevel` | 只能放 `global`；放入 source 内 fail-fast |
| **可覆盖**（三层合并：**source > global > 内置默认**） | `queryTimeoutMs`、`maxRows`、`maxAffectedRows`、`sqlMaxLength`、`maxParams`、`allowWrite`、`tls`、`tlsRejectUnauthorized`、`connectTimeoutMs` | `global` 与 `source` 均可用 |
| **连接参数**（每源必填） | `target`、`host`、`user`、`password`、（`port`、`database`、`charset`） | 仅出现在 source 内；出现在 global 内 fail-fast |

### 4.3 默认值与范围

| 配置项 | 内置默认 | 合法范围/格式 |
| --- | --- | --- |
| `poolSize`（全局专属） | `5` | 整数 1–100 |
| `poolIdleTimeoutMs`（全局专属） | `60000` | 整数 0–3600000；0=禁用 |
| `logLevel`（全局专属） | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `connectTimeoutMs` | `10000` | 整数 100–600000 |
| `queryTimeoutMs` | `30000` | 整数 100–300000 |
| `maxRows` | `1000` | 整数 1–10000 |
| `sqlMaxLength` | `16384` | 整数 1–1048576 |
| `maxParams` | `500` | 整数 0–10000 |
| `maxAffectedRows` | `1000` | 整数 1–100000 |
| `tls` | `false` | `true`/`false` |
| `tlsRejectUnauthorized` | `true` | `true`/`false` |
| `allowWrite` | `false` | `true`/`false` |
| `port`（每源） | `3306` | 整数 1–65535 |
| `charset`（每源） | `utf8mb4` | 合法字符集名 |

### 4.4 校验规则

- 布尔值只接受 `true`/`false`（大小写不敏感）；`1`、`0`、`yes`、`no`、`on`、`off` 一律拒绝。
- 数值做上下界校验；非数字或越界直接 fail-fast。
- `target` 非空、1–64 字符、字符集 `[a-zA-Z0-9_-]`、全局唯一。
- `defaultTarget` 必须指向已有 `target`；缺省取首 source。
- 配置非法时服务启动即失败退出（fail-fast），错误仅含配置项名、**不含值**（脱敏）。

### 4.5 密码与敏感信息

- `password` 字段支持 `${VAR}` 引用（如 `${MYSQL_PASSWORD}`），启动时从环境变量展开。
- 展开后明文仅存**内存**，**禁止写入任何日志**。
- 凭据绝不接受 MCP 工具入参。

完整配置项说明见 [架构文档·配置体系](docs/architecture.zh-CN.md#5-配置体系)。

## 5. 工具使用手册

所有工具输出均以 JSON 字符串返回。执行语义错误通过 `isError: true` + 稳定 `code` + 恒定脱敏 `message` +（相关时）`details` 返回。

### 5.1 `mysql_list_databases` —— 列出可见数据库

```json
{ "target": "app" }
```

输出：

```json
{ "databases": ["information_schema", "app", "analytics"], "truncated": false }
```

### 5.2 `mysql_list_tables` —— 列出某库下的表/视图

```json
{ "target": "app", "schema": "app" }
```

输出：

```json
{ "schema": "app", "tables": ["users", "orders", "v_active_users"], "truncated": false }
```

### 5.3 `mysql_describe_table` —— 查看字段结构

```json
{ "target": "app", "table": "users", "schema": "app" }
```

输出：

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

> `schema` 可选；缺省时使用该数据源的默认库 `database`。若两者皆无，返回 `PARAM`。

### 5.4 `mysql_query` —— 只读查询

使用 `?` 占位符并在 `params` 传值（绝不把输入拼接进 SQL）。

```json
{
  "target": "app",
  "sql": "SELECT id, name, balance FROM users WHERE status = ? ORDER BY id LIMIT 5",
  "params": [1],
  "maxRows": 100,
  "timeoutMs": 5000
}
```

输出：

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

说明：

- 仅允许 `SELECT` / `SHOW` / `EXPLAIN` 的允许子集；其余一律 `POLICY_REJECTED`。
- **大数值**（`BIGINT`、`DECIMAL`）以**字符串**返回，避免精度丢失。
- 结果超过 `maxRows` 时只返回前 `maxRows` 行并置 `truncated: true`（**不是错误**）。
- `maxRows` 与 `timeoutMs` 可选，受目标源上限约束。

### 5.5 `mysql_execute` —— 受控写入

仅对 `allowWrite: true` 的源可用，否则返回 `WRITE_DISABLED`。**在事务中执行** —— 影响行数超源上限则自动回滚。

```json
{
  "target": "write-pool",
  "sql": "UPDATE users SET balance = ? WHERE id = ?",
  "params": [100.00, 42]
}
```

输出：

```json
{ "affectedRows": 1, "changedRows": 1, "insertId": 0, "durationMs": 8 }
```

**允许的写入形态**（仅以下）：

| 形态 | 允许 |
| --- | --- |
| `INSERT INTO t (cols) VALUES (...)`（含多值） | ✅ |
| `UPDATE t SET ... WHERE ...`（必须带非空 `WHERE`） | ✅ |
| `DELETE FROM t WHERE ...`（必须带非空 `WHERE`） | ✅ |
| 无条件 `UPDATE`/`DELETE`、`INSERT ... SELECT`、`REPLACE`、upsert（`ON DUPLICATE KEY UPDATE`）、多表写入、DDL/DCL/TCL/`CALL` | ⛔ 拒绝 |

## 6. 错误处理

所有错误以 `isError: true` 返回 `{ "code", "message", "details"? }`。`message` 恒定且脱敏（绝不泄漏 SQL 正文与凭据）；原始异常栈只进 `stderr` 日志，附带 `req-<n>` 关联 ID。

| 错误码 | 含义 | 常见原因 | 处理方法 |
| --- | --- | --- | --- |
| `CONFIG_INVALID` | 启动配置不合法 | 某配置项缺失/非法 | 修正配置；启动即 fail-fast（消息仅含配置项名） |
| `CONNECTION` | 无法连接到 MySQL | host/端口/凭据错误、网络或账号无权限 | 核对连通性与低权限账号 |
| `TIMEOUT` | 查询/写入超时 | 查询超过 `queryTimeoutMs` | 重试，或调高该源 `queryTimeoutMs` |
| `PARAM` | 工具入参不符合 Schema | 未知 target、SQL/参数过长、占位符与参数数量不匹配、`maxRows`/`timeoutMs` 越界 | 按工具 Schema 修正入参 |
| `POLICY_REJECTED` | 操作超出允许范围 | SQL 不在读写白名单 | 按 `details` 查看拒绝原因 |
| `WRITE_DISABLED` | 写入能力未开启 | 在 `allowWrite=false` 的源调用 `mysql_execute` | 为该源开启 `allowWrite`，或改用只读流程 |
| `RESULT_LIMIT` | 结果/影响行数超限 | 写入影响行数 > `maxAffectedRows`（事务已回滚） | 收窄语句（如补充/细化 `WHERE`） |
| `SERIALIZE` | 结果无法序列化 | 不支持的列值 | 联系维护者，按数据问题处理 |
| `INTERNAL` | 内部错误 | 意外异常 | 查看 `stderr` 日志，携带 `req-<n>` 反馈 |

## 7. 安全模型

1. **stdout / stderr 严格分离**：`stdout` 只承载 MCP 协议帧；所有日志走 `stderr` 并做敏感信息脱敏。
2. **参数化查询**：`params` 一律走预编译绑定，绝不把调用者输入拼接进 SQL。
3. **凭据绝不作为工具入参** —— 仅由服务端配置提供。
4. **事务化写入**，影响行数超限自动回滚（绝不部分提交）。
5. **精确保留数值**（`BIGINT`/`DECIMAL` 以字符串返回）。
6. **纵深防御**：应用层 SQL 策略是第一道防线；**MySQL 账号权限是最终边界**。务必使用低权限账号（见 [examples/grant-ro.sql](examples/grant-ro.sql) / [examples/grant-rw.sql](examples/grant-rw.sql)）。

## 8. 故障排查

| 现象 | 可能原因 | 解决办法 |
| --- | --- | --- |
| 服务启动即退出 | 配置 fail-fast | 查看打印的配置项名；确保布尔为 `true`/`false`、数值在范围、`target` 唯一且为 `[a-zA-Z0-9_-]`；连接参数放 `source`、全局专属字段放 `global` |
| 工具返回 `WRITE_DISABLED` | 该源 `allowWrite=false` | 为该源设 `allowWrite: true`（按源），或使用只读工具 |
| 首次使用返回 `CONNECTION` | 主机不可达或凭据错误 | 核对账号/权限与网络；注意连接池按 target 首次访问才懒建 |
| 意外 `POLICY_REJECTED` | SQL 不在白名单 | 对照允许形态（第 5.5 节）与[工具契约](docs/tool-contracts-and-security.zh-CN.md)决策表 |
| 查询被截断 | 结果 > 该源 `maxRows` | 传入更大 `maxRows`（不超过源上限）或调高上限 |
| 写入意外回滚 | 影响行数 > `maxAffectedRows` | 细化 `WHERE` 或调高上限 |

## 9. 打包与发布

```bash
npm pack   # prepack 自动 clean + build，产出只含 dist/docs/examples 的压缩包
```

`private: true` 防止误发布到 npm registry；如需对外发布，先移除该标记并补充许可证。

## 10. 文档导航

- [架构与调用链](docs/architecture.zh-CN.md) —— 请求链路、模块边界、配置体系、错误码模型。
- [工具契约与安全设计](docs/tool-contracts-and-security.zh-CN.md) —— 5 个工具的输入/输出 Schema、SQL 策略决策表、数据库权限矩阵、序列化语义。
- [测试矩阵与实施路线](docs/testing-and-roadmap.zh-CN.md) —— 单元/集成/安全回归测试矩阵，以及 M0–M4 阶段目标与退出条件。

English: 设计文档见 `docs/*.md`；英文手册见 [README.md](README.md)。

建议阅读顺序：架构与配置 → 工具契约与安全 → 测试与路线。

---

## 许可证

待确定（发布到公开 registry 前补充）。
