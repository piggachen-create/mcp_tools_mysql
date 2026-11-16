/**
 * MySQL 行数据 JSON 序列化。
 * 语义与 docs/tool-contracts-and-security.md 第 5 节一致：
 * - BIGINT/DECIMAL 保留精度转字符串（连接层已配置 bigNumberStrings/decimal 字符串）；
 * - 日期时间返回 MySQL 原样字符串（连接层 dateStrings:true）；
 * - 二进制转 base64，BIT 转位序列字符串；
 * - NULL 保持 null；无法序列化时尽力转字符串。
 */

/** MySQL 协议列类型码（与 mysql2 lib/constants/types.js 保持一致；该包未导出，故本地定义）。 */
export const MYSQL_TYPE = {
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
} as const;

/** 列类型码 → MySQL 类型名（用于输出 columnTypes）。 */
const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  14: 'date',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinyblob',
  250: 'mediumblob',
  251: 'longblob',
  252: 'blob',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
};

/** 结果集列元数据（mysql2 Field 子集：type 即协议类型码）。 */
export interface FieldInfo {
  readonly name: string;
  readonly type: number;
}

/** 序列化后的查询结果。 */
export interface SerializedRows {
  readonly columns: string[];
  readonly columnTypes: string[];
  readonly rows: unknown[][];
  readonly rowCount: number;
  readonly truncated: boolean;
}

/** Buffer（BIT 列）转位序列字符串，去除高位补零；全零返回 "0"。 */
function bufferToBitString(buffer: Buffer): string {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  const stripped = bits.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** 单元格序列化：以运行时类型为主、列类型码消歧（BIT vs BLOB）。 */
export function serializeValue(value: unknown, columnType: number): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
    return columnType === MYSQL_TYPE.BIT
      ? bufferToBitString(value)
      : value.toString('base64');
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // JSON 列等对象值：尽力返回 JSON 文本
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 序列化 mysql2 行数组（rowsAsArray 模式）为契约输出。
 * rows 超过 maxRows 时截断并置 truncated=true。
 */
export function serializeRows(
  rows: unknown[][],
  fields: FieldInfo[],
  maxRows: number,
): SerializedRows {
  const columns = fields.map((f) => f.name);
  const columnTypes = fields.map((f) => TYPE_NAMES[f.type] ?? 'unknown');
  const truncated = rows.length > maxRows;
  const limited = truncated ? rows.slice(0, maxRows) : rows;
  return {
    columns,
    columnTypes,
    rows: limited.map((row) =>
      row.map((cell, i) => serializeValue(cell, fields[i]?.type ?? 0)),
    ),
    rowCount: limited.length,
    truncated,
  };
}
