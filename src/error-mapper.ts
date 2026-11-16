/**
 * MySQL 错误 → 稳定错误码映射。
 * 客户端消息恒定、可本地化，不泄漏 SQL 正文与凭据；
 * 原始错误信息仅以 errno/code 形式写入 stderr 日志。
 * 错误码语义见 docs/architecture.md 第 7 节。
 */
import type { Logger } from './logger.js';
import { ErrorCode, ToolError } from './errors.js';

/** 连接类错误码（网络/握手/认证/默认库不存在）。 */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'PROTOCOL_CONNECTION_TIMEOUT',
  'HANDSHAKE_NO_SSL_SUPPORT',
  'ER_ACCESS_DENIED_ERROR',
  'ER_NOT_SUPPORTED_AUTH_MODE',
  'ER_BAD_DB_ERROR',
]);

/** 查询超时类错误码（mysql2 timeout 选项触发）。 */
const TIMEOUT_CODES: ReadonlySet<string> = new Set(['PROTOCOL_SEQUENCE_TIMEOUT']);

/** 参数/语义类错误码（SQL 不被数据库接受、对象不存在等）。 */
const PARAM_CODES: ReadonlySet<string> = new Set([
  'ER_PARSE_ERROR',
  'ER_EMPTY_QUERY',
  'ER_NO_SUCH_TABLE',
  'ER_UNKNOWN_TABLE',
  'ER_BAD_FIELD_ERROR',
  'ER_WRONG_ARGUMENTS',
  'ER_WRONG_VALUE_COUNT_ON_ROW',
  'ER_UNKNOWN_SYSTEM_VARIABLE',
  'ER_SP_DOES_NOT_EXIST',
  'ER_BAD_NULL_ERROR',
]);

/** 权限兜底拒绝（低权限账号最终安全边界）。 */
const POLICY_CODES: ReadonlySet<string> = new Set([
  'ER_DBACCESS_DENIED_ERROR',
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_PROCACCESS_DENIED_ERROR',
]);

/** 将底层异常映射为携带稳定错误码的 ToolError；未识别错误归为 INTERNAL。 */
export function mapMySqlError(error: unknown, logger: Logger): ToolError {
  if (error instanceof ToolError) return error;
  const err = error as { code?: unknown; errno?: unknown };
  const code = typeof err?.code === 'string' ? err.code : '';
  const errno = typeof err?.errno === 'number' ? err.errno : -1;
  // 原始信息仅进日志，且只记录 code/errno（不记录 message，避免携带 SQL 片段）
  logger.error(`数据库错误：code=${code || 'N/A'} errno=${errno}`);

  if (TIMEOUT_CODES.has(code)) {
    return new ToolError(ErrorCode.TIMEOUT, '查询执行超时');
  }
  if (CONNECTION_CODES.has(code)) {
    return new ToolError(ErrorCode.CONNECTION, '无法连接到 MySQL');
  }
  if (POLICY_CODES.has(code)) {
    return new ToolError(ErrorCode.POLICY_REJECTED, '该操作不在允许范围内', '数据库权限拒绝');
  }
  if (PARAM_CODES.has(code)) {
    return new ToolError(ErrorCode.PARAM, 'SQL 语句或参数不被数据库接受');
  }
  return new ToolError(ErrorCode.INTERNAL, '服务内部错误');
}
