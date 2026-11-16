/**
 * MCP 工具定义与注册。
 * 工具名、输入 Schema 与设计文档 docs/tool-contracts-and-security.md 保持一致。
 * M1 阶段：工具已注册、tools/list 可见；工具处理逻辑在 M2（只读）/M3（受控写入）实现。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ErrorCode } from './errors.js';

/** 标识符约束：1-128 字符，合法字符集 [a-zA-Z0-9_$]。 */
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_$]+$/, '仅允许字母、数字、下划线和美元符号');

/** 参数化值仅允许标量。 */
const scalarParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** 工具注册所需的服务端配置子集。 */
export interface ToolConfig {
  readonly sqlMaxLength: number;
  readonly maxParams: number;
  readonly maxRows: number;
  readonly queryTimeoutMs: number;
  readonly allowWrite: boolean;
}

/** M1 占位处理：统一返回"未实现"，M2/M3 按工具逐一实现。 */
function notImplemented(toolName: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          code: ErrorCode.INTERNAL,
          message: `工具 ${toolName} 尚未实现（M1 阶段仅提供协议骨架）`,
        }),
      },
    ],
    isError: true,
  };
}

/** 在 server 上注册全部工具；mysql_execute 仅在 allowWrite=true 时注册。 */
export function registerTools(server: McpServer, config: ToolConfig): void {
  // 1. 列出当前账号可见的数据库
  server.registerTool(
    'mysql_list_databases',
    {
      title: '列出数据库',
      description: '列出当前 MySQL 账号可见的数据库。',
      inputSchema: {},
    },
    async () => notImplemented('mysql_list_databases'),
  );

  // 2. 列出指定库下的表与视图
  server.registerTool(
    'mysql_list_tables',
    {
      title: '列出表',
      description: '列出指定 Schema 下的表与视图。',
      inputSchema: {
        schema: identifier.describe('目标数据库名（1-128 字符合法标识符）'),
      },
    },
    async () => notImplemented('mysql_list_tables'),
  );

  // 3. 描述单表字段结构
  server.registerTool(
    'mysql_describe_table',
    {
      title: '描述表结构',
      description: '描述单张表/视图的字段结构。',
      inputSchema: {
        table: identifier.describe('目标表名（1-128 字符合法标识符）'),
        schema: identifier
          .optional()
          .describe('表所在数据库名，缺省时使用服务端配置的默认库'),
      },
    },
    async () => notImplemented('mysql_describe_table'),
  );

  // 4. 只读查询
  server.registerTool(
    'mysql_query',
    {
      title: '只读查询',
      description:
        '执行只读查询（SELECT/SHOW/EXPLAIN 允许子集），参数化执行，受行数与超时限制。',
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .max(config.sqlMaxLength)
          .describe('只读 SQL 语句，使用 ? 占位符参数化'),
        params: z
          .array(scalarParam)
          .max(config.maxParams)
          .optional()
          .describe('与占位符对应的参数值数组，仅允许标量'),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(config.maxRows)
          .optional()
          .describe(`最大返回行数，1-${config.maxRows}`),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(config.queryTimeoutMs)
          .optional()
          .describe(`查询超时（毫秒），100-${config.queryTimeoutMs}`),
      },
    },
    async () => notImplemented('mysql_query'),
  );

  // 5. 受控写入：仅 allowWrite=true 时注册
  if (config.allowWrite) {
    server.registerTool(
      'mysql_execute',
      {
        title: '受控写入',
        description:
          '在事务中执行受控 DML：仅允许 INSERT 与带 WHERE 的 UPDATE/DELETE；影响行数超上限自动回滚。',
        inputSchema: {
          sql: z
            .string()
            .min(1)
            .max(config.sqlMaxLength)
            .describe('受控 DML 语句，使用 ? 占位符参数化'),
          params: z
            .array(scalarParam)
            .max(config.maxParams)
            .optional()
            .describe('与占位符对应的参数值数组，仅允许标量'),
        },
      },
      async () => notImplemented('mysql_execute'),
    );
  }
}
