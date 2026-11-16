# MySQL MCP Tool

面向 MySQL 的 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 服务。本服务通过 MCP 协议，让 AI 客户端以统一、受控的方式探查 MySQL 数据库结构并执行只读查询；仅在显式开启时开放受控写入。

> **当前状态：设计阶段（M0）**
> 本仓库当前仅交付**设计文档**，尚未包含任何实现代码。请在动手实现前先阅读并确认三份设计文档。

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

## 快速开始（占位）

> 以下为后续实现完成后规划的目录，**当前不可用**，实现阶段将按设计文档落地。

- 安装依赖：`npm install`
- 构建：`npm run build`
- 配置环境变量：见 [架构文档·配置项](docs/architecture.md#5-配置体系)
- 启动（stdio）：将被 MCP 客户端以子进程方式拉起，或按 MCP 客户端配置引入。

## 许可证

待实现阶段确定后补充。

---

## 文档任务清单

- [x] 仓库初始化（Gitee 私有空仓库，`main` 默认分支）
- [ ] M0 设计冻结：四份设计文档评审通过
- [ ] M1 协议骨架 & 配置解析
- [ ] M2 只读能力（元数据 + 查询）
- [ ] M3 受控写入（条件注册 + 事务化 DML）
- [ ] M4 发布准备（打包、README 快速开始、文档定稿）
