/**
 * 配置解析与 fail-fast 校验。
 * 与设计文档 docs/architecture.md 第 5 节保持一致：
 * - 布尔值只接受 true/false（大小写不敏感），拒绝 1/0/yes/no/on/off。
 * - 数值必须为整数并做上下界校验，越界或非数字直接 fail-fast。
 */
import { ConfigError } from './errors.js';

/** 服务不可变配置。 */
export interface Config {
  // 连接参数
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** 密码仅存在于内存，禁止写入任何日志。 */
  readonly password: string;
  readonly database: string;
  readonly charset: string;
  // 连接与执行限制
  readonly connectTimeoutMs: number;
  readonly poolSize: number;
  readonly poolIdleTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly maxRows: number;
  readonly sqlMaxLength: number;
  readonly maxParams: number;
  readonly maxAffectedRows: number;
  // 功能与安全开关
  readonly tls: boolean;
  readonly tlsRejectUnauthorized: boolean;
  readonly allowWrite: boolean;
  readonly logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** 环境变量读取抽象，便于单元测试注入。 */
export type EnvSource = Record<string, string | undefined>;

/** 布尔只接受 true/false（大小写不敏感）。 */
function parseBoolean(key: string, value: string | undefined): boolean {
  if (value === undefined) {
    throw new ConfigError(`配置项 ${key} 缺失`, key);
  }
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  // 明确拒绝 1/0/yes/no/on/off 等非标准布尔写法
  throw new ConfigError(
    `配置项 ${key} 的值不合法：布尔值只接受 true/false`,
    key,
  );
}

/** 可选布尔：未设置时使用默认值；设置为空串视为非法（布尔只接受明确格式）。 */
function parseBooleanOptional(
  key: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  return parseBoolean(key, value);
}

/** 必填字符串：缺失或为空直接 fail-fast。 */
function parseRequiredString(key: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`配置项 ${key} 缺失或为空`, key);
  }
  return value;
}

/** 可选字符串：未设置时使用默认值。 */
function parseStringOptional(
  value: string | undefined,
  defaultValue: string,
): string {
  if (value === undefined || value === '') return defaultValue;
  return value;
}

/** 整数解析：非数字或越界直接 fail-fast。 */
function parseIntInRange(
  key: string,
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return defaultValue;
  // 十六进制/浮点等一律视为非法，仅接受十进制整数
  if (!/^-?\d+$/.test(value)) {
    throw new ConfigError(`配置项 ${key} 不是合法整数：${min}-${max}`, key);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(
      `配置项 ${key} 超出合法范围：${min}-${max}`,
      key,
    );
  }
  return parsed;
}

/** 日志级别枚举校验。 */
function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = parseStringOptional(value, 'info').toLowerCase();
  const levels: readonly string[] = [
    'debug',
    'info',
    'warn',
    'error',
    'silent',
  ];
  if (!levels.includes(normalized)) {
    throw new ConfigError(
      '配置项 MYSQL_LOG_LEVEL 不合法：debug/info/warn/error/silent',
      'MYSQL_LOG_LEVEL',
    );
  }
  return normalized as LogLevel;
}

/** 从环境变量解析并校验全部配置；任一项非法抛出 ConfigError（fail-fast）。 */
export function loadConfig(env: EnvSource = process.env): Config {
  const config: Config = {
    host: parseRequiredString('MYSQL_HOST', env['MYSQL_HOST']),
    port: parseIntInRange('MYSQL_PORT', env['MYSQL_PORT'], 3306, 1, 65535),
    user: parseRequiredString('MYSQL_USER', env['MYSQL_USER']),
    password: parseRequiredString('MYSQL_PASSWORD', env['MYSQL_PASSWORD']),
    database: parseStringOptional(env['MYSQL_DATABASE'], ''),
    charset: parseStringOptional(env['MYSQL_CHARSET'], 'utf8mb4'),

    connectTimeoutMs: parseIntInRange(
      'MYSQL_CONNECT_TIMEOUT_MS',
      env['MYSQL_CONNECT_TIMEOUT_MS'],
      10000,
      100,
      600000,
    ),
    poolSize: parseIntInRange(
      'MYSQL_POOL_SIZE',
      env['MYSQL_POOL_SIZE'],
      5,
      1,
      100,
    ),
    poolIdleTimeoutMs: parseIntInRange(
      'MYSQL_POOL_IDLE_TIMEOUT_MS',
      env['MYSQL_POOL_IDLE_TIMEOUT_MS'],
      60000,
      0,
      3600000,
    ),
    queryTimeoutMs: parseIntInRange(
      'MYSQL_QUERY_TIMEOUT_MS',
      env['MYSQL_QUERY_TIMEOUT_MS'],
      30000,
      100,
      300000,
    ),
    maxRows: parseIntInRange(
      'MYSQL_MAX_ROWS',
      env['MYSQL_MAX_ROWS'],
      1000,
      1,
      10000,
    ),
    sqlMaxLength: parseIntInRange(
      'MYSQL_SQL_MAX_LENGTH',
      env['MYSQL_SQL_MAX_LENGTH'],
      16384,
      1,
      1048576,
    ),
    maxParams: parseIntInRange(
      'MYSQL_MAX_PARAMS',
      env['MYSQL_MAX_PARAMS'],
      500,
      0,
      10000,
    ),
    maxAffectedRows: parseIntInRange(
      'MYSQL_MAX_AFFECTED_ROWS',
      env['MYSQL_MAX_AFFECTED_ROWS'],
      1000,
      1,
      100000,
    ),

    tls: parseBooleanOptional('MYSQL_TLS', env['MYSQL_TLS'], false),
    tlsRejectUnauthorized: parseBooleanOptional(
      'MYSQL_TLS_REJECT_UNAUTHORIZED',
      env['MYSQL_TLS_REJECT_UNAUTHORIZED'],
      true,
    ),
    allowWrite: parseBooleanOptional(
      'MYSQL_ALLOW_WRITE',
      env['MYSQL_ALLOW_WRITE'],
      false,
    ),
    logLevel: parseLogLevel(env['MYSQL_LOG_LEVEL']),
  };
  return config;
}
