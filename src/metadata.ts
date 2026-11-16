/**
 * 元数据服务：list_databases / list_tables / describe_table 的 information_schema 查询封装。
 * 输出契约见 docs/tool-contracts-and-security.md 第 2 节。
 * 标识符已经过 zod 字符集校验（[a-zA-Z0-9_$]，无法包含引号/空白），直接内联拼接安全；
 * 值参数一律走占位符绑定。
 */
import { ErrorCode, ToolError } from './errors.js';
import type { SqlRunner } from './pool.js';

/** 工具服务端配置子集。 */
export interface MetadataLimits {
  readonly maxRows: number;
  readonly queryTimeoutMs: number;
}

export interface DatabaseList {
  readonly databases: string[];
  readonly truncated: boolean;
}

export interface TableList {
  readonly schema: string;
  readonly tables: string[];
  readonly truncated: boolean;
}

export interface ColumnStructure {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly key: string;
  readonly default: string | null;
  readonly extra: string;
}

export interface TableDescription {
  readonly schema: string;
  readonly table: string;
  readonly columns: ColumnStructure[];
}

/** 列出当前账号可见的数据库。 */
export async function listDatabases(
  runner: SqlRunner,
  limits: MetadataLimits,
): Promise<DatabaseList> {
  const { rows } = await runner.run(
    'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name LIMIT ?',
    [limits.maxRows + 1],
    limits.queryTimeoutMs,
  );
  const names = rows.map((row) => String(row[0]));
  const truncated = names.length > limits.maxRows;
  return {
    databases: truncated ? names.slice(0, limits.maxRows) : names,
    truncated,
  };
}

/** 列出指定库下的表与视图。 */
export async function listTables(
  runner: SqlRunner,
  limits: MetadataLimits,
  schema: string,
): Promise<TableList> {
  const { rows } = await runner.run(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name LIMIT ?',
    [schema, limits.maxRows + 1],
    limits.queryTimeoutMs,
  );
  const names = rows.map((row) => String(row[0]));
  const truncated = names.length > limits.maxRows;
  return {
    schema,
    tables: truncated ? names.slice(0, limits.maxRows) : names,
    truncated,
  };
}

/** 描述单表字段结构；表不存在或无权限时返回 PARAM 类错误（契约第 2.3 节）。 */
export async function describeTable(
  runner: SqlRunner,
  limits: MetadataLimits,
  table: string,
  schema?: string,
): Promise<TableDescription> {
  const { rows } = await runner.run(
    [
      'SELECT column_name, data_type, is_nullable, column_key, column_default, extra',
      'FROM information_schema.columns',
      'WHERE table_schema = ? AND table_name = ?',
      'ORDER BY ordinal_position',
    ].join(' '),
    [schema ?? '', table],
    limits.queryTimeoutMs,
  );
  if (rows.length === 0) {
    throw new ToolError(ErrorCode.PARAM, '表不存在或无权限查看', `table=${table}`);
  }
  const columns: ColumnStructure[] = rows.map((row) => ({
    name: String(row[0]),
    type: String(row[1]),
    nullable: String(row[2]) === 'YES',
    key: String(row[3] ?? ''),
    default: row[4] === null || row[4] === undefined ? null : String(row[4]),
    extra: String(row[5] ?? ''),
  }));
  return { schema: schema ?? '', table, columns };
}
