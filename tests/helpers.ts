/** 测试共享工具：构造最小可用配置与假执行器。 */
import type { Config } from '../src/config.js';
import type { SqlRunner, QueryResult } from '../src/pool.js';
import { createLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';

/** 构造测试配置（默认仅只读）。 */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: 'localhost',
    port: 3306,
    user: 'tester',
    password: 'secret',
    database: 'app',
    charset: 'utf8mb4',
    connectTimeoutMs: 10000,
    poolSize: 5,
    poolIdleTimeoutMs: 60000,
    queryTimeoutMs: 30000,
    maxRows: 1000,
    sqlMaxLength: 16384,
    maxParams: 500,
    maxAffectedRows: 1000,
    tls: false,
    tlsRejectUnauthorized: true,
    allowWrite: false,
    logLevel: 'silent',
    ...overrides,
  };
}

/** 静默日志器（测试不产生 stderr 噪音）。 */
export function silentLogger(): Logger {
  return createLogger('silent');
}

/**
 * 假执行器：可预设结果或按调用抛错，并记录调用参数。
 */
export class FakeRunner implements SqlRunner {
  readonly calls: { sql: string; params: readonly unknown[]; timeoutMs: number }[] = [];

  constructor(
    private readonly respond: (
      call: { sql: string; params: readonly unknown[]; timeoutMs: number },
    ) => QueryResult,
  ) {}

  async run(sql: string, params: readonly unknown[], timeoutMs: number): Promise<QueryResult> {
    this.calls.push({ sql, params, timeoutMs });
    return this.respond({ sql, params, timeoutMs });
  }
}

/** 常量结果假执行器。 */
export function staticRunner(result: QueryResult): FakeRunner {
  return new FakeRunner(() => result);
}
