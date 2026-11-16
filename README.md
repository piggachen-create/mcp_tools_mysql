# MySQL MCP Tool

面向 MySQL 的 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 服务。本服务通过 MCP 协议，让 AI 客户端以统一、受控的方式探查 MySQL 数据库结构并执行只读查询；仅在显式开启时开放受控写入。

> **当前状态：M4 已完成（发布准备）**
> M1 交付 stdio 协议骨架与配置 fail-fast；M2 交付连接池、元数据三工具、`mysql_query` 只读查询（AST 白名单分类 + 参数化 + 限行限超时）、序列化与错误映射；M3 交付 `mysql_execute` 受控写入（条件注册 + AST 写入白名单 + 事务化执行 + 影响行数超限自动回滚）；M4 完成打包脚本、快速开始实化、示例授权脚本与文档定稿。

## 项目定位

- **能力**：通过 MCP 工具向 AI 客户端提供 MySQL 元数据读取（库/表/结构）与受控的多数据库查询能力；可选地开放受限写入。
- **技术栈**：Node.js + TypeScript，官方 MCP TypeScript SDK，`mysql2/promise` 驱动。
- **传输方式**：首版仅支持 `stdio` transport，不设计 HTTP/SSE、多租户或管理后台。
- **默认只读**：默认模式下不注册任何写入工具。只有在启动配置显式开启写入开关后，才注册受控的 `mysql_execute` 工具。
- **安全边界**：SQL 应用层策略只是纵深防御的第一道；**MySQL 账号权限才是最终安全边界**。服务要求使用低权限数据库账号运行。

## 首版能力

| 工具 | 说明 | 默认注册 |
| --- | --- | --- |
| `mysql_list_databases` | 列出当前账号可见的数据库 | ✅ |
| `mysql_list_tables` | 列出指定 Schema 下的表与视图 | ✅ |
| `mysql_describe_table` | 描述单张表/视图的字段结构 | ✅ |
| `mysql_query` | 执行只读查询（参数化，限行数、限超时） | ✅ |
| `mysql_execute` | 在事务中执行受控 DML（仅 `INSERT`、带 `WHERE` 的 `UPDATE`/`DELETE`） | ⛔ 仅开启写入后 |

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

- 只读模式（默认）：执行 [examples/grant-ro.sql](examples/grant-ro.sql)
- 受控写入模式：执行 [examples/grant-rw.sql](examples/grant-rw.sql)，并配合 `MYSQL_ALLOW_WRITE=true`

### 3. 配置环境变量

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MYSQL_HOST` | ✅ | 无 | 主机名/IPv4/IPv6 |
| `MYSQL_USER` | ✅ | 无 | 数据库账号（建议 `mysql_mcp_ro`） |
| `MYSQL_PASSWORD` | ✅ | 无 | **禁止出现在任何日志中** |
| `MYSQL_PORT` | 否 | `3306` | 1–65535 |
| `MYSQL_DATABASE` | 否 | 空 | 账号默认库 |
| `MYSQL_ALLOW_WRITE` | 否 | `false` | 仅接受 `true`/`false`；开启后注册 `mysql_execute` |
| `MYSQL_MAX_ROWS` | 否 | `1000` | 单次查询最大返回行数 |
| `MYSQL_QUERY_TIMEOUT_MS` | 否 | `30000` | 查询超时上限（100–300000） |
| `MYSQL_MAX_AFFECTED_ROWS` | 否 | `1000` | 写入影响行数上限，超限自动回滚 |

完整配置项（含 TLS、连接池、SQL 长度等）见 [架构文档·配置体系](docs/architecture.md#5-配置体系)。

### 4. 接入 MCP 客户端（stdio）

以 Claude Desktop（`claude_desktop_config.json`）或 Cursor（`.cursor/mcp.json`）为例，将服务作为子进程拉起：

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["/absolute/path/to/mysql-mcp-tool/dist/index.js"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "mysql_mcp_ro",
        "MYSQL_PASSWORD": "<强密码>",
        "MYSQL_DATABASE": "app"
      }
    }
  }
}
```

如需受控写入，改用可写账号并追加 `"MYSQL_ALLOW_WRITE": "true"`（工具列表中才会出现 `mysql_execute`）。任一配置非法时服务启动即失败退出（fail-fast），错误仅含配置项名、不含值。

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
- [x] M2 只读能力（元数据 + 查询 + 序列化 + 错误映射）
- [x] M3 受控写入（条件注册 + 事务化 DML）
- [x] M4 发布准备（打包、README 快速开始、文档定稿）
