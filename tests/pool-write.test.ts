/**
 * 受控写入事务语义单元测试：executeDmlInTransaction + 假 TransactionSession。
 * 覆盖 docs/tool-contracts-and-security.md 4.3 节：BEGIN → 执行 → 上限检查 →
 * COMMIT / ROLLBACK；任何异常统一回滚，绝不部分提交。
 */
import { describe, expect, it } from 'vitest';
import {
  executeDmlInTransaction,
  extractWriteOutcome,
  type TransactionSession,
} from '../src/pool.js';
import { ErrorCode, ToolError } from '../src/errors.js';

interface SessionLog {
  begin: number;
  commit: number;
  rollback: number;
}

/** 假事务会话：记录 BEGIN/COMMIT/ROLLBACK 次数，可注入各阶段错误。 */
function fakeSession(options: {
  result?: unknown;
  failAt?: 'begin' | 'statement' | 'commit' | 'rollback';
  error?: unknown;
}): { session: TransactionSession; log: SessionLog; statementArgs: { get: () => unknown } } {
  const log: SessionLog = { begin: 0, commit: 0, rollback: 0 };
  let statementArgs: unknown;
  const failError = options.error ?? new Error('注入的数据库错误');
  const session: TransactionSession = {
    beginTransaction: async () => {
      log.begin += 1;
      if (options.failAt === 'begin') throw failError;
    },
    runStatement: async (statement) => {
      statementArgs = statement;
      if (options.failAt === 'statement') throw failError;
      return options.result;
    },
    commit: async () => {
      log.commit += 1;
      if (options.failAt === 'commit') throw failError;
    },
    rollback: async () => {
      log.rollback += 1;
      if (options.failAt === 'rollback') throw failError;
    },
  };
  return { session, log, statementArgs: { get: () => statementArgs } };
}

const SQL = 'UPDATE users SET name = ? WHERE id = ?';
const PARAMS = ['x', 1];

describe('extractWriteOutcome', () => {
  it('从 mysql2 数组结果 [OkPacket, fields] 提取摘要', () => {
    const outcome = extractWriteOutcome([
      { affectedRows: 3, changedRows: 2, insertId: 0 },
      [],
    ]);
    expect(outcome).toEqual({ affectedRows: 3, changedRows: 2, insertId: null });
  });

  it('裸 OkPacket 同样支持；changedRows 缺省回落 affectedRows', () => {
    const outcome = extractWriteOutcome({ affectedRows: 5, insertId: 7 });
    expect(outcome).toEqual({ affectedRows: 5, changedRows: 5, insertId: 7 });
  });

  it('insertId 为 0 或缺失时返回 null', () => {
    expect(extractWriteOutcome({ affectedRows: 1, changedRows: 1, insertId: 0 }).insertId).toBeNull();
    expect(extractWriteOutcome({ affectedRows: 1 }).insertId).toBeNull();
  });

  it('空结果兜底为 0/null，不抛错', () => {
    expect(extractWriteOutcome(null)).toEqual({ affectedRows: 0, changedRows: 0, insertId: null });
    expect(extractWriteOutcome([])).toEqual({ affectedRows: 0, changedRows: 0, insertId: null });
  });
});

describe('executeDmlInTransaction：提交路径', () => {
  it('成功：BEGIN → 执行 → COMMIT，返回影响行数摘要', async () => {
    const { session, log, statementArgs } = fakeSession({
      result: [{ affectedRows: 2, changedRows: 1, insertId: 0 }, []],
    });
    const outcome = await executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000);
    expect(outcome).toEqual({ affectedRows: 2, changedRows: 1, insertId: null });
    expect(log).toEqual({ begin: 1, commit: 1, rollback: 0 });
    // 语句透传：参数复制绑定 + 超时
    const statement = statementArgs.get() as { sql: string; values: unknown[]; timeout: number };
    expect(statement.sql).toBe(SQL);
    expect(statement.values).toEqual(PARAMS);
    expect(statement.timeout).toBe(5000);
  });

  it('影响行数等于上限（边界）不回滚', async () => {
    const { session, log } = fakeSession({
      result: [{ affectedRows: 1000, changedRows: 1000, insertId: 0 }, []],
    });
    await expect(executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000)).resolves.toMatchObject({
      affectedRows: 1000,
    });
    expect(log).toEqual({ begin: 1, commit: 1, rollback: 0 });
  });
});

describe('executeDmlInTransaction：回滚路径', () => {
  it('影响行数超上限 → ROLLBACK + RESULT_LIMIT，绝不 COMMIT', async () => {
    const { session, log } = fakeSession({
      result: [{ affectedRows: 1001, changedRows: 1001, insertId: 0 }, []],
    });
    await expect(executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000)).rejects.toMatchObject({
      code: ErrorCode.RESULT_LIMIT,
    });
    expect(log).toEqual({ begin: 1, commit: 0, rollback: 1 });
  });

  it('RESULT_LIMIT 携带脱敏 details（仅行数，不含 SQL）', async () => {
    const { session } = fakeSession({
      result: [{ affectedRows: 2000, changedRows: 2000, insertId: 0 }, []],
    });
    const error = await executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).details).toBe('affectedRows=2000, maxAffectedRows=1000');
    expect(JSON.stringify(error)).not.toContain(SQL);
  });

  it('执行报错 → 回滚一次并原样抛出', async () => {
    const dbError = Object.assign(new Error("Table 'app.t' doesn't exist"), {
      code: 'ER_NO_SUCH_TABLE',
    });
    const { session, log } = fakeSession({ failAt: 'statement', error: dbError });
    await expect(executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000)).rejects.toBe(dbError);
    expect(log).toEqual({ begin: 1, commit: 0, rollback: 1 });
  });

  it('COMMIT 报错 → 回滚并原样抛出', async () => {
    const commitError = Object.assign(new Error('commit failed'), { code: 'ER_ERROR_ON_WRITE' });
    const { session, log } = fakeSession({
      result: [{ affectedRows: 1, changedRows: 1, insertId: 0 }, []],
      failAt: 'commit',
      error: commitError,
    });
    await expect(executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000)).rejects.toBe(
      commitError,
    );
    expect(log).toEqual({ begin: 1, commit: 1, rollback: 1 });
  });

  it('ROLLBACK 失败不掩盖原始执行错误', async () => {
    const dbError = Object.assign(new Error('Query inactivity timeout'), {
      code: 'PROTOCOL_SEQUENCE_TIMEOUT',
    });
    const { session, log } = fakeSession({ failAt: 'statement', error: dbError });
    let rollbackAttempts = 0;
    session.rollback = async () => {
      rollbackAttempts += 1;
      throw new Error('回滚也失败了');
    };
    await expect(executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000)).rejects.toBe(dbError);
    expect(rollbackAttempts).toBe(1);
    expect(log).toEqual({ begin: 1, commit: 0, rollback: 0 });
  });

  it('BEGIN 失败：未开启事务，不回滚，原样抛出', async () => {
    const beginError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const { session, log } = fakeSession({ failAt: 'begin', error: beginError });
    await expect(executeDmlInTransaction(session, SQL, PARAMS, 5000, 1000)).rejects.toBe(
      beginError,
    );
    expect(log).toEqual({ begin: 1, commit: 0, rollback: 0 });
  });
});
