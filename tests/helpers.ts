/** 测试共享工具：构造最小可用配置与假执行器（只读 run + 受控写入 runWrite）。 */
import type { Config } from '../src/config.js';
import type { SqlRunner, SqlWriter, QueryResult, ExecuteOutcome } from '../src/pool.js';
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
