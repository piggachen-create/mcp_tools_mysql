/**
 * MCP 工具定义与注册。
 * 工具名、输入 Schema 与输出契约见 docs/tool-contracts-and-security.md。
 * 多数据源：每个工具入参可选 target 指定数据源，缺省用默认源；执行器按 target 从
 * ConnectionManager 解析（resolveRunner/resolveWriter）。mysql_execute 常注册，handler
 * 内按该源 allowWrite 判定，未开启返回 WRITE_DISABLED。
 * 语义错误统一以 isError:true + {code,message,details?} JSON 返回；原始异常只进 stderr 日志。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatasourceConfig, SourcesConfig } from './config.js';
import { ErrorCode, ToolError } from './errors.js';
import { mapMySqlError } from './error-mapper.js';
import { describeTable, listDatabases, listTables } from './metadata.js';
import type { SqlRunner, SqlWriter } from './pool.js';
import { serializeRows } from './serializer.js';
import { classifyExecuteSql, classifyQuerySql } from './sql-classifier.js';
import type { Logger } from './logger.js';

/** 标识符约束：1-128 字符，合法字符集 [a-zA-Z0-9_$]。 */
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_$]+$/, '仅允许字母、数字、下划线和美元符号');

/** 数据源 target 约束：1-64 字符，合法字符集 [a-zA-Z0-9_-]，可选。 */
const targetField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'target 仅允许字母、数字、下划线、连字符')
  .optional()
  .describe('目标数据源标识；缺省使用默认数据源');

/** 参数化值仅允许标量。 */
const scalarParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** 工具层依赖：多源配置 + 按 target 解析执行器/配置 + 日志。 */
export interface ToolServices {
  readonly sources: SourcesConfig;
  /** 只读执行器：缺省 defaultTarget。 */
  readonly resolveRunner: (target?: string) => SqlRunner;
  /** 写执行器：缺省 defaultTarget。 */
  readonly resolveWriter: (target?: string) => SqlWriter;
  /** 按 target 取合并后配置（含每源限制项）。 */
  readonly configFor: (target?: string) => DatasourceConfig;
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

/** 策略拒绝结果：恒定脱敏消息 + 分类器给出的具体原因。 */
function policyResult(reason: string): CallResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          code: ErrorCode.POLICY_REJECTED,
          message: '该操作不在允许范围内',
          details: reason,
        }),
      },
    ],
    isError: true,
  };
}

/** 在 server 上注册全部工具；数据源执行器按 target 从 services 解析。 */
export function registerTools(server: McpServer, services: ToolServices): void {
  const { configFor, resolveRunner, resolveWriter, logger } = services;

  // 1. 列出当前账号可见的数据库
  server.registerTool(
    'mysql_list_databases',
    {
      title: '列出数据库',
      description: '列出指定数据源（缺省默认源）当前 MySQL 账号可见的数据库。',
      inputSchema: {
        target: targetField,
      },
    },
    async ({ target }) => {
      const reqId = nextRequestId();
      try {
        const cfg = configFor(target);
        const runner = resolveRunner(target);
        const result = await listDatabases(runner, {
          maxRows: cfg.maxRows,
          queryTimeoutMs: cfg.queryTimeoutMs,
        });
        logger.info(
          `${reqId} mysql_list_databases 成功：target=${cfg.target} databases=${result.databases.length} 项${result.truncated ? '（截断）' : ''}`,
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
      description: '列出指定数据源（缺省默认源）下指定 Schema 的表与视图。',
      inputSchema: {
        target: targetField,
        schema: identifier.describe('目标数据库名（1-128 字符合法标识符）'),
      },
    },
    async ({ target, schema }) => {
      const reqId = nextRequestId();
      try {
        const cfg = configFor(target);
        const runner = resolveRunner(target);
        const result = await listTables(runner, {
          maxRows: cfg.maxRows,
          queryTimeoutMs: cfg.queryTimeoutMs,
        }, schema);
        logger.info(
          `${reqId} mysql_list_tables 成功：target=${cfg.target} schema=${schema} 共 ${result.tables.length} 项${result.truncated ? '（截断）' : ''}`,
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
      description: '描述指定数据源（缺省默认源）下单张表/视图的字段结构。',
      inputSchema: {
        target: targetField,
        table: identifier.describe('目标表名（1-128 字符合法标识符）'),
        schema: identifier
          .optional()
          .describe('表所在数据库名，缺省时使用该数据源的默认库'),
      },
    },
    async ({ target, table, schema }) => {
      const reqId = nextRequestId();
      try {
        const cfg = configFor(target);
        const runner = resolveRunner(target);
        const effectiveSchema = schema ?? cfg.database;
        if (effectiveSchema === '') {
          throw new ToolError(
            ErrorCode.PARAM,
            '未指定 schema 且该数据源未配置默认库',
          );
        }
        const result = await describeTable(runner, {
          maxRows: cfg.maxRows,
          queryTimeoutMs: cfg.queryTimeoutMs,
        }, table, effectiveSchema);
        logger.info(
          `${reqId} mysql_describe_table 成功：target=${cfg.target} ${result.schema}.${result.table} 共 ${result.columns.length} 列`,
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
        '在指定数据源（缺省默认源）执行只读查询（SELECT/SHOW/EXPLAIN 允许子集），参数化执行，受行数与超时限制。',
      inputSchema: {
        target: targetField,
        sql: z
          .string()
          .min(1)
          .describe('只读 SQL 语句，使用 ? 占位符参数化'),
        params: z
          .array(scalarParam)
          .optional()
          .describe('与占位符对应的参数值数组，仅允许标量'),
        maxRows: z.number().int().min(1).optional().describe('最大返回行数，1-10000'),
        timeoutMs: z.number().int().min(100).optional().describe('查询超时（毫秒），100-300000'),
      },
    },
    async ({ target, sql, params, maxRows, timeoutMs }) => {
      const reqId = nextRequestId();
      try {
        const cfg = configFor(target);
        // SQL/params 长度上限按该源合并配置二次校验（注册期只能用全局默认）
        if (sql.trim().length === 0) {
          throw new ToolError(ErrorCode.PARAM, 'SQL 不能为空白');
        }
        if (sql.trim().length > cfg.sqlMaxLength) {
          throw new ToolError(
            ErrorCode.PARAM,
            'SQL 超过该数据源长度上限',
            `sqlMaxLength=${cfg.sqlMaxLength}`,
          );
        }
        const boundParams = params ?? [];
        if (boundParams.length > cfg.maxParams) {
          throw new ToolError(
            ErrorCode.PARAM,
            '参数数量超过该数据源上限',
            `maxParams=${cfg.maxParams}`,
          );
        }
        if (maxRows !== undefined && maxRows > cfg.maxRows) {
          throw new ToolError(
            ErrorCode.PARAM,
            'maxRows 超过该数据源上限',
            `maxRows=${cfg.maxRows}`,
          );
        }
        if (timeoutMs !== undefined && timeoutMs > cfg.queryTimeoutMs) {
          throw new ToolError(
            ErrorCode.PARAM,
            'timeoutMs 超过该数据源上限',
            `queryTimeoutMs=${cfg.queryTimeoutMs}`,
          );
        }
        const trimmed = sql.trim();
        // 策略判定：AST 只读白名单 + 危险特征（锁定读取/文件输出/用户变量/危险函数/多语句）
        const classification = classifyQuerySql(trimmed);
        if (!classification.ok) {
          logger.warn(`${reqId} mysql_query 策略拒绝：${classification.reason}`);
          return policyResult(classification.reason ?? '不允许的操作');
        }
        if (boundParams.length !== classification.placeholders) {
          throw new ToolError(
            ErrorCode.PARAM,
            '占位符与参数数量不一致',
            `placeholders=${classification.placeholders}, params=${boundParams.length}`,
          );
        }
        const runner = resolveRunner(target);
        const effectiveMaxRows = maxRows ?? cfg.maxRows;
        const effectiveTimeout = timeoutMs ?? cfg.queryTimeoutMs;
        const start = Date.now();
        const { rows, fields } = await runner.run(trimmed, boundParams, effectiveTimeout);
        const durationMs = Date.now() - start;
        const serialized = serializeRows(rows, fields, effectiveMaxRows);
        logger.info(
          `${reqId} mysql_query 成功：target=${cfg.target} ${serialized.rowCount} 行${serialized.truncated ? '（截断）' : ''}，耗时 ${durationMs}ms`,
        );
        return jsonResult({ ...serialized, durationMs });
      } catch (error) {
        return errorResult(error, logger, reqId);
      }
    },
  );

  // 5. 受控写入：常注册；handler 内按该源 allowWrite 判定（未开启返回 WRITE_DISABLED）。
  //    事务化执行，影响行数超上限自动回滚。限制项取该源合并配置。
  server.registerTool(
    'mysql_execute',
    {
      title: '受控写入',
      description:
        '在指定数据源（缺省默认源）事务中执行受控 DML：仅允许 INSERT 与带 WHERE 的 UPDATE/DELETE；影响行数超上限自动回滚；该数据源未开启写入时拒绝。',
      inputSchema: {
        target: targetField,
        sql: z
          .string()
          .min(1)
          .describe('受控 DML 语句，使用 ? 占位符参数化'),
        params: z
          .array(scalarParam)
          .optional()
          .describe('与占位符对应的参数值数组，仅允许标量'),
      },
    },
    async ({ target, sql, params }) => {
      const reqId = nextRequestId();
      try {
        const cfg = configFor(target);
        if (!cfg.allowWrite) {
          throw new ToolError(ErrorCode.WRITE_DISABLED, '该数据源未开启写入能力');
        }
        const trimmed = sql.trim();
        if (trimmed === '') {
          throw new ToolError(ErrorCode.PARAM, 'SQL 不能为空白');
        }
        if (trimmed.length > cfg.sqlMaxLength) {
          throw new ToolError(
            ErrorCode.PARAM,
            'SQL 超过该数据源长度上限',
            `sqlMaxLength=${cfg.sqlMaxLength}`,
          );
        }
        // 策略判定：AST 写入白名单（INSERT/带 WHERE 的 UPDATE/DELETE）+ 危险特征/多语句
        const classification = classifyExecuteSql(trimmed);
        if (!classification.ok) {
          logger.warn(`${reqId} mysql_execute 策略拒绝：${classification.reason}`);
          return policyResult(classification.reason ?? '不允许的操作');
        }
        const boundParams = params ?? [];
        if (boundParams.length > cfg.maxParams) {
          throw new ToolError(
            ErrorCode.PARAM,
            '参数数量超过该数据源上限',
            `maxParams=${cfg.maxParams}`,
          );
        }
        if (boundParams.length !== classification.placeholders) {
          throw new ToolError(
            ErrorCode.PARAM,
            '占位符与参数数量不一致',
            `placeholders=${classification.placeholders}, params=${boundParams.length}`,
          );
        }
        const writer = resolveWriter(target);
        const start = Date.now();
        const outcome = await writer.runWrite(
          trimmed,
          boundParams,
          cfg.queryTimeoutMs,
          cfg.maxAffectedRows,
        );
        const durationMs = Date.now() - start;
        logger.info(
          `${reqId} mysql_execute 成功：target=${cfg.target} affectedRows=${outcome.affectedRows} changedRows=${outcome.changedRows}，耗时 ${durationMs}ms`,
        );
        return jsonResult({ ...outcome, durationMs });
      } catch (error) {
        return errorResult(error, logger, reqId);
      }
    },
  );
}
