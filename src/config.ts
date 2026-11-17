/**
 * 多数据源配置解析与 fail-fast 校验。
 * 配置改由 JSON 文件声明（MCP_SOURCES_FILE 指定路径，默认 ./mcp.sources.json），
 * 不再使用平铺 MYSQL_HOST 等环境变量。
 * - 顶层结构：{ global?: {...}, defaultTarget?: string, sources: [{...}] }
 * - 控制粒度：全局默认 + 每源覆盖（三层合并：source 显式 > global > 内置默认）。
 * - 密码支持环境变量引用 ${VAR}，展开后仅存内存，禁止写入任何日志。
 * 一致性见 docs/architecture.md 第 5 节。
 */
import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';

/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** 环境变量读取抽象，便于单元测试注入。 */
export type EnvSource = Record<string, string | undefined>;

/** 进程级全局配置（这些字段不随数据源变化，属全局专属）。 */
export interface GlobalConfig {
  readonly poolSize: number;
  readonly poolIdleTimeoutMs: number;
  readonly logLevel: LogLevel;
  /** 解析后的默认数据源 target。 */
  readonly defaultTarget: string;
}

/**
 * 单个数据源合并后的完整配置。
 * 连接参数为本源必填；可覆盖字段已按 global 合并；可直接用于创建连接池。
 */
export interface DatasourceConfig {
  readonly target: string;
  // 连接参数（每源必填，不参与 global 合并）
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** 密码仅存在于内存，禁止写入任何日志。 */
  readonly password: string;
  readonly database: string;
  readonly charset: string;
  // 可覆盖控制项（source 显式 > global > 内置默认）
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly maxRows: number;
  readonly sqlMaxLength: number;
  readonly maxParams: number;
  readonly maxAffectedRows: number;
  readonly tls: boolean;
  readonly tlsRejectUnauthorized: boolean;
  readonly allowWrite: boolean;
}

/** 多数据源完整配置：全局 + 全部已合并源。 */
export interface SourcesConfig {
  readonly global: GlobalConfig;
  /** 每项均为合并后的完整 DatasourceConfig，可直接建池。 */
  readonly sources: readonly DatasourceConfig[];
}

/** 配置文件默认路径（相对进程 cwd）。 */
export const DEFAULT_SOURCES_FILE = './mcp.sources.json';

// ---------------------------------------------------------------------------
// 字段分类与内置默认
// ---------------------------------------------------------------------------

/** 全局专属字段：仅允许出现在 global，若出现在 source 内视为非法。 */
const GLOBAL_ONLY_FIELDS = new Set(['poolSize', 'poolIdleTimeoutMs', 'logLevel']);

/** 连接参数：source 必填，不参与 global 合并；global 中不得出现。 */
const CONNECTION_FIELDS = new Set([
  'target',
  'host',
  'port',
  'user',
  'password',
  'database',
  'charset',
]);

/** 可覆盖字段内置默认值（source 显式 > global > 此处）。 */
const DEFAULTS = {
  port: 3306,
  database: '',
  charset: 'utf8mb4',
  connectTimeoutMs: 10000,
  queryTimeoutMs: 30000,
  maxRows: 1000,
  sqlMaxLength: 16384,
  maxParams: 500,
  maxAffectedRows: 1000,
  tls: false,
  tlsRejectUnauthorized: true,
  allowWrite: false,
} as const;

const OVERRIDABLE_FIELDS = [
  'connectTimeoutMs',
  'queryTimeoutMs',
  'maxRows',
  'sqlMaxLength',
  'maxParams',
  'maxAffectedRows',
  'tls',
  'tlsRejectUnauthorized',
  'allowWrite',
] as const;

type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

// ---------------------------------------------------------------------------
// 校验原语（复用既有 fail-fast 语义）
// ---------------------------------------------------------------------------

/** 布尔只接受 true/false（大小写不敏感），拒绝 1/0/yes/no 等；兼容 JSON 布尔与字符串。 */
function parseBoolean(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw new ConfigError(`配置项 ${key} 不合法：布尔值只接受 true/false`, key);
  }
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new ConfigError(`配置项 ${key} 不合法：布尔值只接受 true/false`, key);
}

/** 必填字符串：缺失或空直接 fail-fast。 */
function parseRequiredString(key: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`配置项 ${key} 缺失或为空`, key);
  }
  return value;
}

/** 可选字符串：任意字符串或 undefined → 默认。 */
function parseStringOptional(value: unknown, key: string, defaultValue: string): string {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value !== 'string') {
    throw new ConfigError(`配置项 ${key} 类型不合法`, key);
  }
  return value;
}

/** 整数解析：必须整数且落在 [min,max]，否则 fail-fast。 */
function parseIntInRange(
  key: string,
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    throw new ConfigError(`配置项 ${key} 不是合法整数：${min}-${max}`, key);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`配置项 ${key} 超出合法范围：${min}-${max}`, key);
  }
  return parsed;
}

/** 日志级别枚举校验。 */
function parseLogLevel(value: unknown): LogLevel {
  const raw = parseStringOptional(value, 'logLevel', 'info').toLowerCase();
  const levels: readonly string[] = ['debug', 'info', 'warn', 'error', 'silent'];
  if (!levels.includes(raw)) {
    throw new ConfigError('配置项 logLevel 不合法：debug/info/warn/error/silent', 'logLevel');
  }
  return raw as LogLevel;
}

/**
 * target 标识：非空、1–64、全局唯一。
 * 字符集为任意 Unicode 字母/数字（含中文等 CJK 字符）+ 下划线/连字符，
 * 避免真实使用中出现的「运营云AI」这类中文 target 被误拒。
 */
function parseTarget(value: unknown): string {
  const target = parseRequiredString('target', value);
  if (target.length > 64 || !/^[\p{L}\p{N}_-]+$/u.test(target)) {
    throw new ConfigError(
      '配置项 target 不合法：仅允许 1-64 位字母（含中文）、数字、下划线、连字符',
      'target',
    );
  }
  return target;
}

/**
 * 环境变量引用展开：值形如 ${VAR} 时整体替换为 env 对应值。
 * env 缺失或展开为空 → fail-fast；非引用形态按字面处理。
 */
function expandEnvRef(value: string, env: EnvSource, key: string): string {
  const m = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
  if (!m) return value;
  const varName = m[1] as string;
  const resolved = env[varName];
  if (resolved === undefined || resolved === '') {
    throw new ConfigError(`环境变量引用 ${varName} 缺失或为空`, key);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 顶层解析
// ---------------------------------------------------------------------------

interface RawSource {
  [k: string]: unknown;
}

/** 解析单个 source：校验 target + 连接参数必填 + 可覆盖项与 global 合并。 */
function parseSource(
  raw: RawSource,
  global: RawSource,
  env: EnvSource,
  index: number,
): DatasourceConfig {
  const scope = `sources[${index}]`;
  // 拒绝在 source 内出现的全局专属字段（避免歧义）
  for (const field of GLOBAL_ONLY_FIELDS) {
    if (field in raw) {
      throw new ConfigError(`配置项 ${scope}.${field} 属全局专属，不能配置在单个数据源内`, `${scope}.${field}`);
    }
  }

  const target = parseTarget(raw['target']);
  const host = parseRequiredString(`${scope}.host`, raw['host']);

  // 连接参数（每源必填/默认，不参与 global 合并；global 已拒绝连接字段）
  const port = raw['port'] ?? DEFAULTS.port;
  const database = raw['database'] ?? DEFAULTS.database;
  const charset = raw['charset'] ?? DEFAULTS.charset;

  // 可覆盖项：source 显式 > global > 内置默认
  const apply = (field: OverridableField): unknown => {
    const rawValue = raw[field];
    if (rawValue !== undefined && rawValue !== null) return rawValue;
    if (global[field] !== undefined && global[field] !== null) return global[field];
    return DEFAULTS[field];
  };

  return {
    target,
    host,
    port: parseIntInRange(`${scope}.port`, port, DEFAULTS.port, 1, 65535),
    user: parseRequiredString(`${scope}.user`, raw['user']),
    // 密码支持环境变量引用展开；展开后明文仅存内存
    password: expandEnvRef(
      parseRequiredString(`${scope}.password`, raw['password']),
      env,
      `${scope}.password`,
    ),
    database: parseStringOptional(database, `${scope}.database`, DEFAULTS.database),
    charset: parseStringOptional(charset, `${scope}.charset`, DEFAULTS.charset),
    connectTimeoutMs: parseIntInRange(
      `${scope}.connectTimeoutMs`, apply('connectTimeoutMs') as unknown, DEFAULTS.connectTimeoutMs, 100, 600000,
    ),
    queryTimeoutMs: parseIntInRange(
      `${scope}.queryTimeoutMs`, apply('queryTimeoutMs') as unknown, DEFAULTS.queryTimeoutMs, 100, 300000,
    ),
    maxRows: parseIntInRange(
      `${scope}.maxRows`, apply('maxRows') as unknown, DEFAULTS.maxRows, 1, 10000,
    ),
    sqlMaxLength: parseIntInRange(
      `${scope}.sqlMaxLength`, apply('sqlMaxLength') as unknown, DEFAULTS.sqlMaxLength, 1, 1048576,
    ),
    maxParams: parseIntInRange(
      `${scope}.maxParams`, apply('maxParams') as unknown, DEFAULTS.maxParams, 0, 10000,
    ),
    maxAffectedRows: parseIntInRange(
      `${scope}.maxAffectedRows`, apply('maxAffectedRows') as unknown, DEFAULTS.maxAffectedRows, 1, 100000,
    ),
    tls: parseBoolean(`${scope}.tls`, apply('tls') as unknown),
    tlsRejectUnauthorized: parseBoolean(
      `${scope}.tlsRejectUnauthorized`, apply('tlsRejectUnauthorized') as unknown,
    ),
    allowWrite: parseBoolean(`${scope}.allowWrite`, apply('allowWrite') as unknown),
  };
}

/** 从 JSON 文件加载并校验多数据源配置；任何不合法直接抛 ConfigError（fail-fast）。 */
export function loadSourcesConfig(opts: {
  file?: string;
  env?: EnvSource;
} = {}): SourcesConfig {
  const env = opts.env ?? process.env;
  const file = opts.file ?? env['MCP_SOURCES_FILE'] ?? DEFAULT_SOURCES_FILE;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`无法读取配置文件：${file}`, 'MCP_SOURCES_FILE');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`配置文件不是合法 JSON：${file}`, 'MCP_SOURCES_FILE');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('配置文件顶层必须是对象', 'MCP_SOURCES_FILE');
  }
  const root = parsed as Record<string, unknown>;

  // global 可选对象
  let globalRaw: RawSource = {};
  if (root['global'] !== undefined) {
    if (root['global'] === null || typeof root['global'] !== 'object' || Array.isArray(root['global'])) {
      throw new ConfigError('配置项 global 必须是对象', 'global');
    }
    globalRaw = root['global'] as RawSource;
    // global 中不允许出现连接参数
    for (const field of CONNECTION_FIELDS) {
      if (field in globalRaw) {
        throw new ConfigError(`配置项 global.${field} 属连接参数，不能配置在全局中`, `global.${field}`);
      }
    }
  }

  // sources 必填非空数组
  const rawSources = root['sources'];
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw new ConfigError('配置项 sources 必须是非空数组', 'sources');
  }

  // 解析每个 source
  const sources: DatasourceConfig[] = [];
  const seenTargets = new Set<string>();
  rawSources.forEach((rawSource, index) => {
    if (rawSource === null || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
      throw new ConfigError(`配置项 sources[${index}] 必须是对象`, `sources[${index}]`);
    }
    const source = parseSource(rawSource as RawSource, globalRaw, env, index);
    if (seenTargets.has(source.target)) {
      throw new ConfigError(`存在重复的数据源 target：${source.target}`, 'target');
    }
    seenTargets.add(source.target);
    sources.push(source);
  });

  // defaultTarget：显式声明必须存在；缺省取首个 source（sources 已保证非空）
  let defaultTarget: string;
  if (root['defaultTarget'] !== undefined) {
    defaultTarget = parseTarget(root['defaultTarget']);
    if (!seenTargets.has(defaultTarget)) {
      throw new ConfigError(`defaultTarget 指向不存在的数据源：${defaultTarget}`, 'defaultTarget');
    }
  } else {
    defaultTarget = sources[0]!.target;
  }

  // global 专属字段（默认值兜底）
  const global: GlobalConfig = {
    poolSize: parseIntInRange('poolSize', globalRaw['poolSize'], 5, 1, 100),
    poolIdleTimeoutMs: parseIntInRange(
      'poolIdleTimeoutMs', globalRaw['poolIdleTimeoutMs'], 60000, 0, 3600000,
    ),
    logLevel: parseLogLevel(globalRaw['logLevel']),
    defaultTarget,
  };

  return { global, sources };
}
