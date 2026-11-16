/** 测试共享工具：构造多源配置、假执行器（只读 run + 受控写入 runWrite）与假多源管理器。 */
import type {
  DatasourceConfig,
  GlobalConfig,
  SourcesConfig,
} from '../src/config.js';
import type {
  SqlRunner,
  SqlWriter,
  QueryResult,
  ExecuteOutcome,
} from '../src/pool.js';
import { ErrorCode, ToolError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';

/** 构造单个数据源合并配置（默认仅只读）。 */
export function makeDatasourceConfig(
  overrides: Partial<DatasourceConfig> = {},
): DatasourceConfig {
  return {
    target: 'app',
    host: 'localhost',
    port: 3306,
    user: 'tester',
    password: 'secret',
    database: 'app',
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
    ...overrides,
  };
}

/** 构造全局配置。 */
export function makeGlobalConfig(
  overrides: Partial<GlobalConfig> = {},
): GlobalConfig {
  return {
    poolSize: 5,
    poolIdleTimeoutMs: 60000,
    logLevel: 'silent',
    defaultTarget: 'app',
    ...overrides,
  };
}

/** 构造多源配置（含 defaultTarget，缺省取首个 source 的 target）。 */
export function makeSourcesConfig(
  sources: DatasourceConfig[],
  globalOverrides: Partial<GlobalConfig> = {},
): SourcesConfig {
  const defaultTarget =
    globalOverrides.defaultTarget ?? (sources.length > 0 ? sources[0].target : 'app');
  return {
    global: makeGlobalConfig({ ...globalOverrides, defaultTarget }),
    sources,
  };
}

/** 静默日志器（测试不产生 stderr 噪音）。 */
export function silentLogger(): Logger {
  return createLogger('silent');
}

/** 受控写入调用记录。 */
export interface WriteCall {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly timeoutMs: number;
  readonly maxAffectedRows: number;
}

/**
 * 假执行器：可预设结果或按调用抛错，并记录调用参数。
 * writeRespond 预设写入结果（或抛错）；未预设时调用 runWrite 直接失败，防止意外触达。
 */
export class FakeRunner implements SqlRunner, SqlWriter {
  readonly calls: { sql: string; params: readonly unknown[]; timeoutMs: number }[] = [];
  readonly writeCalls: WriteCall[] = [];

  constructor(
    private readonly respond: (
      call: { sql: string; params: readonly unknown[]; timeoutMs: number },
    ) => QueryResult,
    private readonly writeRespond: (call: WriteCall) => ExecuteOutcome = () => {
      throw new Error('未预期的 runWrite 调用');
    },
  ) {}

  async run(sql: string, params: readonly unknown[], timeoutMs: number): Promise<QueryResult> {
    this.calls.push({ sql, params, timeoutMs });
    return this.respond({ sql, params, timeoutMs });
  }

  async runWrite(
    sql: string,
    params: readonly unknown[],
    timeoutMs: number,
    maxAffectedRows: number,
  ): Promise<ExecuteOutcome> {
    const call = { sql, params, timeoutMs, maxAffectedRows };
    this.writeCalls.push(call);
    return this.writeRespond(call);
  }
}

/** 常量结果假执行器。 */
export function staticRunner(result: QueryResult): FakeRunner {
  return new FakeRunner(() => result);
}

/**
 * 假多源管理器：按 target 维护 FakeRunner 映射，模拟数据源分派。
 * 提供 resolveRunner/resolveWriter/configFor，供工具多源测试注入。
 */
export class FakeManager {
  readonly runners = new Map<string, FakeRunner>();

  constructor(
    private readonly sourcesConfig: SourcesConfig,
    runnerByTarget: Record<string, FakeRunner>,
  ) {
    for (const [target, runner] of Object.entries(runnerByTarget)) {
      this.runners.set(target, runner);
    }
  }

  private resolveTarget(target?: string): string {
    return target ?? this.sourcesConfig.global.defaultTarget;
  }

  configFor(target?: string): DatasourceConfig {
    const resolved = this.resolveTarget(target);
    const cfg = this.sourcesConfig.sources.find((s) => s.target === resolved);
    if (!cfg) {
      throw new ToolError(ErrorCode.PARAM, '目标数据源不存在', `target=${resolved}`);
    }
    return cfg;
  }

  resolveRunner(target?: string): SqlRunner {
    return this.runnerFor(target);
  }

  resolveWriter(target?: string): SqlWriter {
    return this.runnerFor(target);
  }

  private runnerFor(target?: string): FakeRunner {
    const resolved = this.resolveTarget(target);
    const runner = this.runners.get(resolved);
    if (!runner) throw new Error(`缺乏测试执行器：${resolved}`);
    return runner;
  }
}
