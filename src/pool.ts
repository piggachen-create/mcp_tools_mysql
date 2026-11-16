/**
 * MySQL 连接池：单数据源、懒创建、进程退出清理。
 * - 池参数来自 Config（poolSize / poolIdleTimeoutMs / connectTimeoutMs）。
 * - multipleStatements:false 防多语句，其余防线见分类器与后端校验。
 * - 查询超时使用 mysql2 timeout 选项；超时后销毁连接，防止脏连接回池。
 * 生命周期约定见 docs/architecture.md 第 4 节。
 */
import mysql from 'mysql2/promise';
import type { Config } from './config.js';
import type { FieldInfo } from './serializer.js';

/** 驱动层执行结果（rowsAsArray 模式）。 */
export interface QueryResult {
  readonly rows: unknown[][];
  readonly fields: FieldInfo[];
}

/** SQL 执行抽象：工具层依赖此接口，便于单元测试注入假实现。 */
export interface SqlRunner {
  /** 以只读语义执行语句；params 通过占位符绑定，timeoutMs 控制查询超时。 */
  run(sql: string, params: readonly unknown[], timeoutMs: number): Promise<QueryResult>;
}

/** mysql2 预备语句不支持的错误码：回退到文本协议（占位符由驱动转义绑定，绝不拼接）。 */
const UNSUPPORTED_PREPARE_CODES: ReadonlySet<string> = new Set(['ER_UNSUPPORTED_PS']);

function toFieldInfo(field: { name: string; type: number }): FieldInfo {
  return { name: field.name, type: field.type };
}

export class MysqlPool implements SqlRunner {
  private pool?: mysql.Pool;

  constructor(private readonly config: Config) {}

  /** 懒创建池：首次执行时建立连接，启动阶段不强制验证连通性。 */
  private getPool(): mysql.Pool {
    if (!this.pool) {
      const { config } = this;
      this.pool = mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database === '' ? undefined : config.database,
        charset: config.charset,
        connectTimeout: config.connectTimeoutMs,
        connectionLimit: config.poolSize,
        maxIdle: config.poolSize,
        idleTimeout: config.poolIdleTimeoutMs,
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

  /** 优雅关闭池；进程退出清理钩子调用。 */
  async end(): Promise<void> {
    if (this.pool) {
      const closing = this.pool;
      this.pool = undefined;
      await closing.end();
    }
  }
}
