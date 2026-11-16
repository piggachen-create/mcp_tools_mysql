/**
 * MCP 工具定义与注册。
 * 工具名、输入 Schema 与输出契约见 docs/tool-contracts-and-security.md。
 * M2：4 个只读工具已实现真实逻辑；mysql_execute 仍为占位（M3 实现受控写入）。
 * 语义错误统一以 isError:true + {code,message,details?} JSON 返回；原始异常只进 stderr 日志。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { ErrorCode, ToolError } from './errors.js';
import { mapMySqlError } from './error-mapper.js';
import { describeTable, listDatabases, listTables } from './metadata.js';
import type { SqlRunner } from './pool.js';
import { serializeRows } from './serializer.js';
import { classifyQuerySql } from './sql-classifier.js';
import type { Logger } from './logger.js';

/** 标识符约束：1-128 字符，合法字符集 [a-zA-Z0-9_$]。 */
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_$]+$/, '仅允许字母、数字、下划线和美元符号');

/** 参数化值仅允许标量。 */
const scalarParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** 工具层依赖（连接执行器 + 日志 + 全量配置）。 */
export interface ToolServices {
  readonly config: Config;
  readonly runner: SqlRunner;
  readonly logger: Logger;
}

/** 递增请求关联 ID，日志与错误响应一致携带（docs/architecture.md 第 6 节）。 */
let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

type CallResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** 成功结果：payload 序列化为 content[].text。 */
function jsonResult(payload: unknown): CallResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * 失败结果：ToolError 携带稳定错误码；其余异常经错误映射。
 * 客户端只见恒定脱敏消息；原因详情仅进 stderr 日志。
 */
function errorResult(error: unknown, logger: Logger, reqId: string): CallResult {
  const toolError =
    error instanceof ToolError
      ? error
      : mapMySqlError(error, logger);
  logger.warn(`${reqId} 失败：code=${toolError.code}${toolError.details ? ` details=${toolError.details}` : ''}`);
  const payload: Record<string, string> = { code: toolError.code, message: toolError.message };
  if (toolError.details !== undefined) payload['details'] = toolError.details;
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

/** 在 server 上注册全部工具；mysql_execute 仅在 allowWrite=true 时注册（M3 前为占位）。 */
export function registerTools(server: McpServer, services: ToolServices): void {
  const { config, runner, logger } = services;

  // 1. 列出当前账号可见的数据库
  server.registerTool(
    'mysql_list_databases',
    {
      title: '列出数据库',
      description: '列出当前 MySQL 账号可见的数据库。',
      inputSchema: {},
    },
    async () => {
      const reqId = nextRequestId();
      try {
        const result = await listDatabases(runner, {
          maxRows: config.maxRows,
          queryTimeoutMs: config.queryTimeoutMs,
        });
        logger.info(
          `${reqId} mysql_list_databases 成功：${result.databases.length} 项${result.truncated ? '（截断）' : ''}`,
        );
        return jsonResult(result);
      } catch (error) {
        return errorResult(error, logger, reqId);
      }
    },
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
    async ({ schema }) => {
      const reqId = nextRequestId();
      try {
        const result = await listTables(runner, {
          maxRows: config.maxRows,
          queryTimeoutMs: config.queryTimeoutMs,
        }, schema);
        logger.info(
          `${reqId} mysql_list_tables 成功：schema=${schema} 共 ${result.tables.length} 项${result.truncated ? '（截断）' : ''}`,
        );
        return jsonResult(result);
      } catch (error) {
        return errorResult(error, logger, reqId);
      }
    },
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
    async ({ table, schema }) => {
      const reqId = nextRequestId();
      try {
        const effectiveSchema = schema ?? config.database;
        if (effectiveSchema === '') {
          throw new ToolError(
            ErrorCode.PARAM,
            '未指定 schema 且服务端未配置默认库',
          );
        }
        const result = await describeTable(runner, {
          maxRows: config.maxRows,
          queryTimeoutMs: config.queryTimeoutMs,
        }, table, effectiveSchema);
        logger.info(
          `${reqId} mysql_describe_table 成功：${result.schema}.${result.table} 共 ${result.columns.length} 列`,
        );
        return jsonResult(result);
      } catch (error) {
        return errorResult(error, logger, reqId);
      }
    },
  );

  // 4. 只读查询：AST 分类 → 占位符校验 → 限行限超时执行 → 序列化
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
    async ({ sql, params, maxRows, timeoutMs }) => {
      const reqId = nextRequestId();
      try {
        const trimmed = sql.trim();
        if (trimmed === '') {
          throw new ToolError(ErrorCode.PARAM, 'SQL 不能为空白');
        }
        // 策略判定：AST 只读白名单 + 危险特征（锁定读取/文件输出/用户变量/危险函数/多语句）
        const classification = classifyQuerySql(trimmed);
        if (!classification.ok) {
          logger.warn(`${reqId} mysql_query 策略拒绝：${classification.reason}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  code: ErrorCode.POLICY_REJECTED,
                  message: '该操作不在允许范围内',
                  details: classification.reason,
                }),
              },
            ],
            isError: true,
          };
        }
        const boundParams = params ?? [];
        if (boundParams.length !== classification.placeholders) {
          throw new ToolError(
            ErrorCode.PARAM,
            '占位符与参数数量不一致',
            `placeholders=${classification.placeholders}, params=${boundParams.length}`,
          );
        }
        const effectiveMaxRows = maxRows ?? config.maxRows;
        const effectiveTimeout = timeoutMs ?? config.queryTimeoutMs;
        const start = Date.now();
        const { rows, fields } = await runner.run(trimmed, boundParams, effectiveTimeout);
        const durationMs = Date.now() - start;
        const serialized = serializeRows(rows, fields, effectiveMaxRows);
        logger.info(
          `${reqId} mysql_query 成功：${serialized.rowCount} 行${serialized.truncated ? '（截断）' : ''}，耗时 ${durationMs}ms`,
        );
        return jsonResult({ ...serialized, durationMs });
      } catch (error) {
        return errorResult(error, logger, reqId);
      }
    },
  );

  // 5. 受控写入：仅 allowWrite=true 时注册；M3 提供真实实现
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
      async () => {
        const reqId = nextRequestId();
        return errorResult(
          new ToolError(ErrorCode.INTERNAL, '受控写入将在 M3 阶段实现'),
          logger,
          reqId,
        );
      },
    );
  }
}
