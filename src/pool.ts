/**
 * MySQL 连接池：单数据源、懒创建、进程退出清理；以及多数据源连接管理器。
 * - MysqlPool 针对单个已合并数据源配置维护一个 mysql2 池。
 * - ConnectionManager 按 target 懒建并复用多个 MysqlPool，为工具层按数据源分派执行器。
 * - 池参数（poolSize/poolIdleTimeoutMs）来自 GlobalConfig（进程级），经构造注入。
 * - multipleStatements:false 防多语句，其余防线见分类器与后端校验。
 * - 查询超时使用 mysql2 timeout 选项；超时后销毁连接，防止脏连接回池。
 * - 受控写入走事务：影响行数超上限自动 ROLLBACK，任何异常统一 ROLLBACK，绝不部分提交。
 * 生命周期约定见 docs/architecture.md 第 4 节；写入语义见 docs/tool-contracts-and-security.md 第 4 节。
 */
import mysql from 'mysql2/promise';
import type { DatasourceConfig, GlobalConfig } from './config.js';
import type { FieldInfo } from './serializer.js';
import { ErrorCode, ToolError } from './errors.js';

/** 驱动层执行结果（rowsAsArray 模式）。 */
export interface QueryResult {
  readonly rows: unknown[][];
  readonly fields: FieldInfo[];
}

/** 受控写入执行结果（docs/tool-contracts-and-security.md 4.4 节）。 */
export interface ExecuteOutcome {
  readonly affectedRows: number;
  readonly changedRows: number;
  /** INSERT 时的自增 ID；无则为 null。 */
  readonly insertId: number | null;
}

/** SQL 执行抽象：工具层依赖此接口，便于单元测试注入假实现。 */
export interface SqlRunner {
  /** 以只读语义执行语句；params 通过占位符绑定，timeoutMs 控制查询超时。 */
  run(sql: string, params: readonly unknown[], timeoutMs: number): Promise<QueryResult>;
}

/** 写入执行抽象：mysql_execute 依赖此接口，便于单元测试注入假实现。 */
export interface SqlWriter {
  /** 事务化执行受控 DML；影响行数超 maxAffectedRows 时回滚并抛 RESULT_LIMIT。 */
  runWrite(
    sql: string,
    params: readonly unknown[],
    timeoutMs: number,
    maxAffectedRows: number,
  ): Promise<ExecuteOutcome>;
}

/**
 * 事务会话抽象：真实实现由 mysql2 连接适配，单测注入假实现验证事务语义。
 */
export interface TransactionSession {
  beginTransaction(): Promise<void>;
  /** 返回 mysql2 结果（DML 为 [OkPacket, fields] 或 OkPacket）。 */
  runStatement(options: { sql: string; values: unknown[]; timeout: number }): Promise<unknown>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** mysql2 预备语句不支持的错误码：回退到文本协议（占位符由驱动转义绑定，绝不拼接）。 */
const UNSUPPORTED_PREPARE_CODES: ReadonlySet<string> = new Set(['ER_UNSUPPORTED_PS']);

function toFieldInfo(field: { name: string; type: number }): FieldInfo {
  return { name: field.name, type: field.type };
}

/** 从 mysql2 结果中提取受控写入摘要（OkPacket；缺省字段按 0/null 兜底）。 */
export function extractWriteOutcome(result: unknown): ExecuteOutcome {
  const packet = (Array.isArray(result) ? (result[0] ?? null) : result) as unknown;
  const row = (packet ?? {}) as Record<string, unknown>;
  const affectedRows = typeof row['affectedRows'] === 'number' ? row['affectedRows'] : 0;
  const changedRows = typeof row['changedRows'] === 'number' ? row['changedRows'] : affectedRows;
  const insertId =
    typeof row['insertId'] === 'number' && row['insertId'] > 0 ? row['insertId'] : null;
  return { affectedRows, changedRows, insertId };
}

/**
 * 事务化执行核心（docs/tool-contracts-and-security.md 4.3 节）：
 * BEGIN → 执行 → 读取 affectedRows → 超限 ROLLBACK（RESULT_LIMIT）/ 否则 COMMIT。
 * 任何异常统一 ROLLBACK 后抛出；ROLLBACK 失败不掩盖原始异常。
 */
export async function executeDmlInTransaction(
  session: TransactionSession,
  sql: string,
  params: readonly unknown[],
  timeoutMs: number,
  maxAffectedRows: number,
): Promise<ExecuteOutcome> {
  // BEGIN 失败：事务未开启，无需回滚，直接抛给上层
  await session.beginTransaction();

  let rolledBack = false;
  try {
    const result = await session.runStatement({
      sql,
      values: [...params],
      timeout: timeoutMs,
    });
    const outcome = extractWriteOutcome(result);
    if (outcome.affectedRows > maxAffectedRows) {
      // 影响行数超上限：显式回滚后再报 RESULT_LIMIT，绝不部分提交
      rolledBack = true;
      await session.rollback();
      throw new ToolError(
        ErrorCode.RESULT_LIMIT,
        '写入影响行数超过上限，已回滚',
        `affectedRows=${outcome.affectedRows}, maxAffectedRows=${maxAffectedRows}`,
      );
    }
    await session.commit();
    return outcome;
  } catch (error) {
    if (!rolledBack) {
      try {
        await session.rollback();
      } catch {
        // 回滚失败不掩盖原始异常：连接状态由上层按错误类型处置
      }
    }
    throw error;
  }
}

export class MysqlPool implements SqlRunner, SqlWriter {
  private pool?: mysql.Pool;

  constructor(
    private readonly config: DatasourceConfig,
    private readonly global: Pick<GlobalConfig, 'poolSize' | 'poolIdleTimeoutMs'>,
  ) {}

  /** 懒创建池：首次执行时建立连接，启动阶段不强制验证连通性。 */
  private getPool(): mysql.Pool {
    if (!this.pool) {
      const { config, global } = this;
      this.pool = mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database === '' ? undefined : config.database,
        charset: config.charset,
        connectTimeout: config.connectTimeoutMs,
        connectionLimit: global.poolSize,
        maxIdle: global.poolSize,
        idleTimeout: global.poolIdleTimeoutMs,
        waitForConnections: true,
        multipleStatements: false,
        // 序列化语义（docs/tool-contracts-and-security.md 第 5 节）
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        ssl: config.tls ? { rejectUnauthorized: config.tlsRejectUnauthorized } : undefined,
      });
    }
    return this.pool;
  }

  /** 执行语句：优先预备语句，驱动不支持时回退文本协议；超时销毁连接。 */
  async run(
    sql: string,
    params: readonly unknown[],
    timeoutMs: number,
  ): Promise<QueryResult> {
    const pool = this.getPool();
    const conn = await pool.getConnection();
    try {
      const options = { sql, values: [...params], timeout: timeoutMs, rowsAsArray: true };
      let result: [unknown[], { name: string; type: number }[]];
      try {
        result = (await conn.execute(options)) as [unknown[], { name: string; type: number }[]];
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code !== 'string' || !UNSUPPORTED_PREPARE_CODES.has(code)) throw error;
        // 该语句形态不支持预备：回退文本协议（占位符仍由驱动转义绑定）
        result = (await conn.query(options)) as [unknown[], { name: string; type: number }[]];
      }
      const rows = (result[0] ?? []) as unknown[][];
      return { rows, fields: (result[1] ?? []).map(toFieldInfo) };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
        // 查询超时后连接状态不可知：销毁而非回池
        conn.destroy();
      }
      throw error;
    } finally {
      // destroy 后 _pool 为 null，release 为安全空操作
      conn.release();
    }
  }

  /** 受控写入：事务化执行（BEGIN/执行/上限检查/COMMIT 或 ROLLBACK），绝不部分提交。 */
  async runWrite(
    sql: string,
    params: readonly unknown[],
    timeoutMs: number,
    maxAffectedRows: number,
  ): Promise<ExecuteOutcome> {
    const pool = this.getPool();
    const conn = await pool.getConnection();
    const options = { sql, values: [...params], timeout: timeoutMs, rowsAsArray: true };
    const session: TransactionSession = {
      beginTransaction: () => conn.beginTransaction(),
      runStatement: async (statement) => {
        try {
          return await conn.execute(statement);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (typeof code !== 'string' || !UNSUPPORTED_PREPARE_CODES.has(code)) throw error;
          // 不支持预备的语句形态：回退文本协议（占位符仍由驱动转义绑定）
          return await conn.query(statement);
        }
      },
      commit: () => conn.commit(),
      rollback: () => conn.rollback(),
    };
    try {
      return await executeDmlInTransaction(session, sql, params, timeoutMs, maxAffectedRows);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
        // 超时后连接状态不可知：销毁而非回池
        conn.destroy();
      }
      throw error;
    } finally {
      conn.release();
    }
  }

  /** 优雅关闭池；进程退出清理钩子调用。 */
  async end(): Promise<void> {
    if (this.pool) {
      const closing = this.pool;
      this.pool = undefined;
      await closing.end();
    }
  }
}

/**
 * 多数据源连接管理器：按 target 懒建并复用 MysqlPool，为工具层按数据源分派执行器。
 * - 未知 target → ToolError(PARAM,...)。
 * - resolve 首次访问某 target 才创建池；未访问源不占连接。
 * - endAll 遍历关闭全部池（进程退出清理钩子调用）。
 * 本类为解析器而非执行器：仅负责按 target 提供 SqlRunner/SqlWriter。
 */
export class ConnectionManager {
  private readonly pools = new Map<string, MysqlPool>();

  constructor(
    private readonly sources: readonly DatasourceConfig[],
    private readonly global: Pick<GlobalConfig, 'poolSize' | 'poolIdleTimeoutMs'>,
    private readonly defaultTarget: string,
  ) {}

  /** target → 已合并配置；undefined 落到默认源；未知 target 抛 ToolError(PARAM)。 */
  configFor(target?: string): DatasourceConfig {
    const resolved = this.resolveTarget(target);
    const cfg = this.sources.find((s) => s.target === resolved);
    if (!cfg) {
      throw new ToolError(ErrorCode.PARAM, '目标数据源不存在', `target=${resolved}`);
    }
    return cfg;
  }

  /** 解析只读执行器：懒建对应 target 的池（MysqlPool 同时实现只读与写入）。 */
  resolve(target?: string): MysqlPool {
    const resolved = this.resolveTarget(target);
    return this.getOrCreate(resolved);
  }

  /** 解析写执行器：MysqlPool 实现 SqlWriter，与只读共用同一池。 */
  resolveWriter(target?: string): SqlWriter {
    return this.resolve(target);
  }

  /** 遍历并并发关闭所有池，随后清空映射。 */
  async endAll(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end()));
  }

  private resolveTarget(target?: string): string {
    return target ?? this.defaultTarget;
  }

  private getOrCreate(target: string): MysqlPool {
    let pool = this.pools.get(target);
    if (!pool) {
      // configFor 已保证 target 存在于 sources
      const cfg = this.sources.find((s) => s.target === target)!;
      pool = new MysqlPool(cfg, this.global);
      this.pools.set(target, pool);
    }
    return pool;
  }
}
