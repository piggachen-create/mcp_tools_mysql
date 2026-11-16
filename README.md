# MySQL MCP Tool

面向 MySQL 的 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 服务。本服务通过 MCP 协议，让 AI 客户端以统一、受控的方式探查 MySQL 数据库结构并执行只读查询；写入能力按数据源显式开启。

> **当前状态：多数据源版已发布（M4 里程碑完成）**
> 配置由单个 JSON 文件（`MCP_SOURCES_FILE`）声明**多数据源**（含 `global` 全局默认 `+ sources` 每源覆盖合并）；`ConnectionManager` 按 target 懒建并复用每源连接池；5 个工具恒定注册，`mysql_execute` 按目标数据源 `allowWrite` 判定可用性。已完成 typecheck 与全部单元测试（249/249）。

## 项目定位

- **能力**：通过 MCP 工具向 AI 客户端提供 MySQL 元数据读取（库/表/结构）与受控的多数据库查询能力；各数据源可独立开启受限写入。
- **技术栈**：Node.js + TypeScript，官方 MCP TypeScript SDK，`mysql2/promise` 驱动。
- **传输方式**：首版仅支持 `stdio` transport，不设计 HTTP/SSE、多租户或管理后台。
- **多数据源与按源开关**：一个进程通过 `mcp.sources.json` 声明多个数据源（各以 `target` 标识）；写入能力按**每数据源** `allowWrite` 独立控制，未开启的数据源调用 `mysql_execute` 返回 `WRITE_DISABLED`。
- **安全边界**：SQL 应用层策略只是纵深防御的第一道；**MySQL 账号权限才是最终安全边界**。服务要求使用低权限数据库账号运行。

## 首版能力

| 工具 | 说明 | 默认注册 |
| --- | --- | --- |
| `mysql_list_databases` | 列出指定数据源（缺省默认源）账号可见的数据库 | ✅ |
| `mysql_list_tables` | 列出指定 Schema 下的表与视图 | ✅ |
| `mysql_describe_table` | 描述单张表/视图的字段结构 | ✅ |
| `mysql_query` | 执行只读查询（参数化，限行数、限超时） | ✅ |
| `mysql_execute` | 在事务中执行受控 DML（仅 `INSERT`、带 `WHERE` 的 `UPDATE`/`DELETE`）；按目标源 `allowWrite` 判定 | ✅ |

所有工具输入均含可选 `target` 字段：指定数据源标识，缺省落到默认源（`defaultTarget`，缺省取首 source）。

## 非目标（首版明确不做）

- DDL、DCL、TCL：`CREATE` / `ALTER` / `DROP` / `GRANT` / `BEGIN` / `COMMIT` 等一律拒绝。
- 存储过程 / 函数调用（`CALL`）、多语句批处理。
- 任意数据库切换、事务会话管理、会话级 `USE` 后的跨库自由查询。
- HTTP/SSE、多租户、Web 管理界面、鉴权体系。
- 通过 MCP 请求在运行期动态开启/关闭写入能力。

## 核心设计约束

1. **stdout / stderr 严格分离**：`stdout` 只承载 MCP 协议帧；所有日志与诊断信息写入 `stderr`，并做敏感信息脱敏。
2. **参数化查询**：`mysql_query` / `mysql_execute` 的 `params` 必须走预编译参数绑定，不允许将调用者输入拼接进 SQL 文本。
3. **连接凭据不入工具入参**：数据库账号、密码、连接地址等仅由服务端配置提供，调用者无法通过工具参数传入或更改。
4. **写入事务化**：`mysql_execute` 在事务中执行；影响行数超过上限必须回滚，不做部分提交。
5. **精确保留数值**：`BIGINT`、`DECIMAL` 等大数值以字符串形式返回，避免精度丢失。

## 设计文档导航

- [架构与调用链](docs/architecture.md) —— 请求链路、模块边界、配置体系、错误码模型。
- [工具契约与安全设计](docs/tool-contracts-and-security.md) —— 5 个工具的输入/输出 Schema、SQL 策略决策表、数据库权限矩阵、序列化语义。
- [测试矩阵与实施路线](docs/testing-and-roadmap.md) —— 单元/集成/安全回归测试矩阵，以及 M0–M4 阶段目标与退出条件。

建议按上述顺序阅读：先理解整体架构与配置，再核对工具契约与安全策略，最后查看验收标准与路线。

## 快速开始

### 1. 构建与测试

```bash
npm install        # 安装依赖
npm run build      # 编译到 dist/（typecheck + 单测：npm run typecheck / npm test）
```

### 2. 准备低权限数据库账号

服务要求使用低权限账号运行（数据库权限是最终安全边界）：

- 只读数据源（`allowWrite=false`）：执行 [examples/grant-ro.sql](examples/grant-ro.sql)
- 写入数据源（对应 `allowWrite=true`）：执行 [examples/grant-rw.sql](examples/grant-rw.sql)

### 3. 编写多数据源配置（mcp.sources.json）

配置由单个 JSON 文件声明，路径由环境变量 `MCP_SOURCES_FILE` 指定（缺省 `./mcp.sources.json`）。顶层结构：`{ global?, defaultTarget?, sources: [...] }`。

参考 [examples/mcp.sources.json](examples/mcp.sources.json) 的多源示例：

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

**配置要点**

- **环境变量表**：

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MCP_SOURCES_FILE` | 否 | `./mcp.sources.json` | 多数据源 JSON 配置文件路径 |

- **连接参数**（每 `source` 必填，不得放 `global`）：`target`、`host`、`user`、`password`；可选 `port`(3306)、`database`、`charset`(utf8mb4)。
- **全局专属字段**（只能放 `global`）：`poolSize`(5)、`poolIdleTimeoutMs`(60000)、`logLevel`(info)。
- **可覆盖字段**（三层合并 source > global > 内置默认）：`queryTimeoutMs`(30000)、`maxRows`(1000)、`maxAffectedRows`(1000)、`sqlMaxLength`(16384)、`maxParams`(500)、`allowWrite`(false)、`tls`(false)、`tlsRejectUnauthorized`(true)、`connectTimeoutMs`(10000)。
- **`target` 规则**：非空、1–64 字符、字符集 `[a-zA-Z0-9_-]`、全局唯一；`defaultTarget` 缺省取首 source。
- **密码 `${VAR}` 引用**：密码字段支持 `${MYSQL_PASSWORD}` 形式引用环境变量，启动时展开；明文仅存内存，**禁止写入任何日志**。
- 配置非法时服务启动即失败退出（fail-fast），错误仅含配置项名、不含值。

完整配置项说明见 [架构文档·配置体系](docs/architecture.md#5-配置体系)。

### 4. 接入 MCP 客户端（stdio）

以 Claude Desktop（`claude_desktop_config.json`）或 Cursor（`.cursor/mcp.json`）为例，将服务作为子进程拉起，并通过 `MCP_SOURCES_FILE` 指定配置文件路径：

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

- **`target` 说明**：配置中每个数据源以 `target` 标识；调用任意工具时传入可选 `target` 字段指定目标源，缺省落到 `defaultTarget`（例中为 `app`）。例如 `"target": "write-pool"` 即对该可写源执行受控 DML。
- 写入可用性按**目标源** `allowWrite` 判定：对未开启写入的源（如 `app`）调用 `mysql_execute` 返回 `WRITE_DISABLED`。
- 任一配置非法时服务启动即失败退出（fail-fast），错误仅含配置项名、不含值。

### 5. 打包

```bash
npm pack   # prepack 自动 clean + build，产出只含 dist/docs/examples 的压缩包
```

`private: true` 防止误发布到 npm registry；如需对外发布，先移除该标记并补充许可证。

## 许可证

待确定（发布到公开 registry 前补充）。

---

## 文档任务清单

- [x] 仓库初始化（Gitee 私有空仓库，`main` 默认分支）
- [x] M0 设计冻结：四份设计文档评审通过
- [x] M1 协议骨架 & 配置解析
- [x] M2 只读能力（元数据 + 查询 + 序列化 + 错误映射 + 多源 target 分派）
- [x] M3 受控写入（常注册 + 按源 `allowWrite` 判定 + 事务化 DML）
- [x] M4 发布准备（打包、README 快速开始、文档定稿）
