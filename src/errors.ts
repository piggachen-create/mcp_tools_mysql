/**
 * 稳定错误码与错误类型。
 * 与设计文档 docs/architecture.md 第 7 节保持一致。
 */

/** 稳定错误码（客户端可见，恒定、可本地化，不泄漏 SQL 正文与凭据）。 */
export const ErrorCode = {
  /** 服务启动配置不合法（fail-fast） */
  CONFIG_INVALID: 'CONFIG_INVALID',
  /** 无法连接到 MySQL */
  CONNECTION: 'CONNECTION',
  /** 查询/写入超过时限 */
  TIMEOUT: 'TIMEOUT',
  /** 工具入参不符合 Schema */
  PARAM: 'PARAM',
  /** 操作不在允许范围内（SQL 策略拒绝） */
  POLICY_REJECTED: 'POLICY_REJECTED',
  /** 写入能力未开启 */
  WRITE_DISABLED: 'WRITE_DISABLED',
  /** 返回/影响结果超过上限 */
  RESULT_LIMIT: 'RESULT_LIMIT',
  /** 结果无法序列化 */
  SERIALIZE: 'SERIALIZE',
  /** 服务内部错误 */
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * 启动期配置错误。
 * 携带稳定错误码 CONFIG_INVALID 与脱敏详情（仅配置项名，不含值）。
 */
export class ConfigError extends Error {
  readonly code: ErrorCodeType = ErrorCode.CONFIG_INVALID;
  /** 可能为空的失败配置项名，用于日志与脱敏 details。 */
  readonly key?: string;

  constructor(message: string, key?: string) {
    super(message);
    this.name = 'ConfigError';
    this.key = key;
  }
}

/**
 * 工具执行语义错误。
 * message 为面向客户端的恒定脱敏消息；details 仅含脱敏摘要（不含 SQL 正文与凭据）。
 */
export class ToolError extends Error {
  readonly code: ErrorCodeType;
  readonly details?: string;

  constructor(code: ErrorCodeType, message: string, details?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}
