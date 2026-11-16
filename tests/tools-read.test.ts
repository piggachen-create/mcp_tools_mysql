/**
 * 工具端到端单元测试：真实 McpServer + InMemoryTransport + 假多源管理器。
 * 覆盖 docs/testing-and-roadmap.md 第 4 节可单测部分（无外部 MySQL 依赖）。
 * 多数据源：默认单源（app）；mysql_execute 常注册、按源 allowWrite 判定。
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, ToolError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import type { QueryResult } from '../src/pool.js';
import {
  FakeManager,
  FakeRunner,
  makeDatasourceConfig,
  makeSourcesConfig,
  silentLogger,
} from './helpers.js';

interface ToolCallOutcome {
  readonly isError: boolean;
  readonly payload: Record<string, unknown>;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const textBlock = (result.content as { type: string; text?: string }[]).find(
    (block) => block.type === 'text',
  );
  const payload = textBlock?.text !== undefined ? JSON.parse(textBlock.text) : {};
  return { isError: result.isError === true, payload: payload as Record<string, unknown> };
}

/** 构造单源多源配置（app 为默认源）。 */
function singleSources(datasourceOverrides: Record<string, unknown> = {}) {
  return makeSourcesConfig([
    makeDatasourceConfig({ target: 'app', ...datasourceOverrides }),
  ]);
}

async function withClient(
  runner: FakeRunner,
  fn: (client: Client, runner: FakeRunner) => Promise<void>,
  datasourceOverrides: Record<string, unknown> = {},
): Promise<void> {
  const sources = singleSources(datasourceOverrides);
  const manager = new FakeManager(sources, { app: runner });
  const server = createServer({
    sources,
    resolveRunner: (t) => manager.resolveRunner(t),
    resolveWriter: (t) => manager.resolveWriter(t),
    configFor: (t) => manager.configFor(t),
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await fn(client, runner);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listToolNames(client: Client): Promise<string[]> {
  const result = await client.listTools();
  return result.tools.map((tool) => tool.name).sort();
}

function result(rows: unknown[][], fields: { name: string; type: number }[]): QueryResult {
  return { rows, fields };
}

describe('工具注册', () => {
  it('默认注册 5 个工具（mysql_execute 常注册）', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(runner, async (client) => {
      const names = await listToolNames(client);
      expect(names).toEqual([
        'mysql_describe_table',
        'mysql_execute',
        'mysql_list_databases',
        'mysql_list_tables',
        'mysql_query',
      ]);
    });
  });
});

describe('mysql_list_databases', () => {
  it('返回数据库列表', async () => {
    const runner = new FakeRunner(() =>
      result([['information_schema'], ['app']], [{ name: 'schema_name', type: 253 }]),
    );
    await withClient(runner, async (client, r) => {
      const outcome = await callTool(client, 'mysql_list_databases', {});
      expect(outcome.isError).toBe(false);
      expect(outcome.payload).toEqual({
        databases: ['information_schema', 'app'],
        truncated: false,
      });
      // 走 information_schema 且带 LIMIT 参数（maxRows+1）
      expect(r.calls[0].sql).toContain('information_schema.schemata');
      expect(r.calls[0].params[0]).toBe(1001);
    });
  });

  it('连接失败返回 CONNECTION', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    await withClient(runner, async (client) => {
      const outcome = await callTool(client, 'mysql_list_databases', {});
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.CONNECTION);
    });
  });
});

describe('mysql_list_tables', () => {
  it('返回表列表并按 maxRows 截断', async () => {
    const runner = new FakeRunner(() =>
      result([['a'], ['b'], ['c']], [{ name: 'table_name', type: 253 }]),
    );
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_list_tables', { schema: 'app' });
        expect(outcome.isError).toBe(false);
        expect(outcome.payload).toEqual({ schema: 'app', tables: ['a', 'b'], truncated: true });
      },
      { maxRows: 2 },
    );
  });

  it('非法 schema 字符被 Schema 拒绝（含空格/反引号）', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(runner, async (client) => {
      await expect(
        callTool(client, 'mysql_list_tables', { schema: 'app;--' }),
      ).rejects.toThrow();
      expect(runner.calls).toHaveLength(0);
    });
  });
});

describe('mysql_describe_table', () => {
  it('返回字段结构（默认库来自该数据源配置）', async () => {
    const runner = new FakeRunner(() =>
      result(
        [['id', 'bigint', 'NO', 'PRI', null, 'auto_increment'], ['name', 'varchar', 'YES', '', 'NULL', '']],
        Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, type: 253 })),
      ),
    );
    await withClient(runner, async (client, r) => {
      const outcome = await callTool(client, 'mysql_describe_table', { table: 'users' });
      expect(outcome.isError).toBe(false);
      expect(outcome.payload['schema']).toBe('app');
      expect(outcome.payload['columns']).toEqual([
        { name: 'id', type: 'bigint', nullable: false, key: 'PRI', default: null, extra: 'auto_increment' },
        { name: 'name', type: 'varchar', nullable: true, key: '', default: 'NULL', extra: '' },
      ]);
      expect(r.calls[0].params).toEqual(['app', 'users']);
    });
  });

  it('未指定 schema 且该源无默认库 → PARAM', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_describe_table', { table: 'users' });
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
      },
      { database: '' },
    );
  });

  it('表不存在 → PARAM', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(runner, async (client) => {
      const outcome = await callTool(client, 'mysql_describe_table', {
        table: 'missing',
        schema: 'app',
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
    });
  });
});

describe('mysql_query：策略与执行', () => {
  it('只读查询成功并序列化结果', async () => {
    const runner = new FakeRunner(() =>
      result(
        [['1', 'alice', '1234.56'], ['2', 'bob', '7.89']],
        [
          { name: 'id', type: 8 },
          { name: 'name', type: 253 },
          { name: 'balance', type: 246 },
        ],
      ),
    );
    await withClient(runner, async (client, r) => {
      const outcome = await callTool(client, 'mysql_query', {
        sql: 'SELECT id, name, balance FROM users WHERE status = ?',
        params: [1],
        maxRows: 100,
        timeoutMs: 5000,
      });
      expect(outcome.isError).toBe(false);
      expect(outcome.payload['columns']).toEqual(['id', 'name', 'balance']);
      expect(outcome.payload['columnTypes']).toEqual(['bigint', 'varchar', 'decimal']);
      expect(outcome.payload['rows']).toEqual([['1', 'alice', '1234.56'], ['2', 'bob', '7.89']]);
      expect(outcome.payload['rowCount']).toBe(2);
      expect(outcome.payload['truncated']).toBe(false);
      expect(typeof outcome.payload['durationMs']).toBe('number');
      expect(r.calls[0].params).toEqual([1]);
      expect(r.calls[0].timeoutMs).toBe(5000);
    });
  });

  const POLICY_REJECT_CASES = [
    'DROP TABLE users',
    'UPDATE users SET name = 1',
    'DELETE FROM users WHERE id = 1',
    'SELECT * FROM users WHERE id = 1 FOR UPDATE',
    'SELECT SLEEP(10)',
    'SELECT 1; DROP TABLE users',
    'SELECT @x := 1',
    "SELECT * INTO OUTFILE '/tmp/x' FROM users",
  ];
  for (const sql of POLICY_REJECT_CASES) {
    it(`策略拒绝：${JSON.stringify(sql.slice(0, 45))}`, async () => {
      const runner = new FakeRunner(() => result([], []));
      await withClient(runner, async (client, r) => {
        const outcome = await callTool(client, 'mysql_query', { sql });
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.POLICY_REJECTED);
        expect(r.calls).toHaveLength(0);
      });
    });
  }

  it('占位符与参数数量不一致 → PARAM', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(runner, async (client) => {
      const outcome = await callTool(client, 'mysql_query', {
        sql: 'SELECT a FROM t WHERE a = ?',
        params: [1, 2],
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
    });
  });

  it('空白 SQL → PARAM', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(runner, async (client) => {
      const outcome = await callTool(client, 'mysql_query', { sql: '   ' });
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
    });
  });

  it('maxRows 截断：truncated=true 且只返回前 maxRows 行', async () => {
    const runner = new FakeRunner(() =>
      result([['1'], ['2'], ['3']], [{ name: 'id', type: 8 }]),
    );
    await withClient(runner, async (client) => {
      const outcome = await callTool(client, 'mysql_query', {
        sql: 'SELECT id FROM users',
        maxRows: 2,
      });
      expect(outcome.isError).toBe(false);
      expect(outcome.payload['rowCount']).toBe(2);
      expect(outcome.payload['truncated']).toBe(true);
    });
  });

  it('表不存在的数据库错误 → PARAM（脱敏）', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error("Table 'app.missing' doesn't exist"), {
        code: 'ER_NO_SUCH_TABLE',
      });
    });
    await withClient(runner, async (client) => {
      const outcome = await callTool(client, 'mysql_query', { sql: 'SELECT * FROM missing' });
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
      expect(JSON.stringify(outcome.payload)).not.toContain("doesn't exist");
    });
  });

  it('查询超时 → TIMEOUT', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('Query inactivity timeout'), {
        code: 'PROTOCOL_SEQUENCE_TIMEOUT',
      });
    });
    await withClient(runner, async (client) => {
      const outcome = await callTool(client, 'mysql_query', { sql: 'SELECT * FROM big_table' });
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.TIMEOUT);
    });
  });
});

describe('mysql_execute', () => {
  const WRITE_OK: Record<string, unknown> = { sql: 'UPDATE users SET name = ? WHERE id = ?', params: ['x', 1] };

  it('默认源未开启写入 → WRITE_DISABLED', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(runner, async (client, r) => {
      const outcome = await callTool(client, 'mysql_execute', WRITE_OK);
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.WRITE_DISABLED);
      expect(r.writeCalls).toHaveLength(0);
    });
  });

  it('开启写入后受控 DML 成功并返回摘要', async () => {
    const runner = new FakeRunner(
      () => result([], []),
      () => ({ affectedRows: 2, changedRows: 1, insertId: null }),
    );
    await withClient(
      runner,
      async (client, r) => {
        const outcome = await callTool(client, 'mysql_execute', WRITE_OK);
        expect(outcome.isError).toBe(false);
        expect(outcome.payload['affectedRows']).toBe(2);
        expect(outcome.payload['changedRows']).toBe(1);
        expect(outcome.payload['insertId']).toBe(null);
        expect(r.writeCalls[0].sql).toBe('UPDATE users SET name = ? WHERE id = ?');
        expect(r.writeCalls[0].params).toEqual(['x', 1]);
        expect(r.writeCalls[0].timeoutMs).toBe(30000);
        expect(r.writeCalls[0].maxAffectedRows).toBe(1000);
      },
      { allowWrite: true },
    );
  });

  it('INSERT 成功返回自增 insertId', async () => {
    const runner = new FakeRunner(
      () => result([], []),
      () => ({ affectedRows: 1, changedRows: 0, insertId: 42 }),
    );
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_execute', {
          sql: 'INSERT INTO users (name) VALUES (?)',
          params: ['alice'],
        });
        expect(outcome.isError).toBe(false);
        expect(outcome.payload).toMatchObject({ affectedRows: 1, insertId: 42 });
      },
      { allowWrite: true },
    );
  });

  const WRITE_REJECT_CASES = [
    'DROP TABLE users',
    'TRUNCATE TABLE users',
    'UPDATE users SET name = ?',
    'DELETE FROM users',
    'INSERT INTO users VALUES (?)',
    'INSERT INTO a SELECT * FROM b',
    'REPLACE INTO users (name) VALUES (?)',
    'INSERT INTO users (name) VALUES (?) ON DUPLICATE KEY UPDATE name = ?',
    'UPDATE a JOIN b ON a.id = b.id SET a.x = ? WHERE a.id = ?',
    'UPDATE a, b SET a.x = ? WHERE a.id = ?',
    'DELETE a FROM a JOIN b WHERE a.id = ?',
    'INSERT INTO users (name) VALUES (SLEEP(1))',
    'UPDATE users SET name = ? WHERE id = ?; DROP TABLE users',
    'SELECT 1',
    'SHOW TABLES',
    'BEGIN',
    'SET autocommit = 1',
  ];
  for (const sql of WRITE_REJECT_CASES) {
    it(`策略拒绝：${JSON.stringify(sql.slice(0, 50))}`, async () => {
      const runner = new FakeRunner(() => result([], []));
      await withClient(
        runner,
        async (client, r) => {
          const outcome = await callTool(client, 'mysql_execute', { sql });
          expect(outcome.isError).toBe(true);
          expect(outcome.payload['code']).toBe(ErrorCode.POLICY_REJECTED);
          expect(r.writeCalls).toHaveLength(0);
        },
        { allowWrite: true },
      );
    });
  }

  it('占位符与参数数量不一致 → PARAM', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_execute', {
          sql: 'UPDATE users SET name = ? WHERE id = ?',
          params: ['x'],
        });
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
      },
      { allowWrite: true },
    );
  });

  it('影响行数超上限回滚 → RESULT_LIMIT', async () => {
    const runner = new FakeRunner(
      () => result([], []),
      () => {
        throw new ToolError(
          ErrorCode.RESULT_LIMIT,
          '写入影响行数超过上限，已回滚',
          'affectedRows=1001, maxAffectedRows=1000',
        );
      },
    );
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_execute', WRITE_OK);
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.RESULT_LIMIT);
      },
      { allowWrite: true },
    );
  });

  it('写入语句超时 → TIMEOUT', async () => {
    const runner = new FakeRunner(
      () => result([], []),
      () => {
        throw Object.assign(new Error('Query inactivity timeout'), {
          code: 'PROTOCOL_SEQUENCE_TIMEOUT',
        });
      },
    );
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_execute', WRITE_OK);
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.TIMEOUT);
      },
      { allowWrite: true },
    );
  });

  it('写入连接失败 → CONNECTION', async () => {
    const runner = new FakeRunner(
      () => result([], []),
      () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    );
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_execute', WRITE_OK);
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.CONNECTION);
      },
      { allowWrite: true },
    );
  });

  it('空白 SQL → PARAM', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_execute', { sql: '  ' });
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
      },
      { allowWrite: true },
    );
  });
});

describe('多数据源：target 分派与每源覆盖', () => {
  const WRITE_OK: Record<string, unknown> = { sql: 'UPDATE users SET name = ? WHERE id = ?', params: ['x', 1] };

  /** 构造 app（只读，maxRows=1000）+ replica（只读，maxRows=3000）+ rw（可写）。 */
  function multiSources() {
    return makeSourcesConfig([
      makeDatasourceConfig({ target: 'app', maxRows: 1000, allowWrite: false }),
      makeDatasourceConfig({
        target: 'replica',
        host: 'replica-host',
        maxRows: 3000,
        queryTimeoutMs: 5000,
        database: 'analytics',
        allowWrite: false,
      }),
      makeDatasourceConfig({ target: 'rw', allowWrite: true, maxAffectedRows: 50 }),
    ]);
  }

  async function withMulti(
    runnersByName: Record<string, FakeRunner>,
    fn: (client: Client) => Promise<void>,
  ): Promise<void> {
    const sources = multiSources();
    const manager = new FakeManager(sources, runnersByName);
    const server = createServer({
      sources,
      resolveRunner: (t) => manager.resolveRunner(t),
      resolveWriter: (t) => manager.resolveWriter(t),
      configFor: (t) => manager.configFor(t),
      logger: silentLogger(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('缺省 target 落到默认源（app）', async () => {
    const app = new FakeRunner(() => result([['app-1']], [{ name: 'c', type: 253 }]));
    const replica = new FakeRunner(() => result([['replica-1']], [{ name: 'c', type: 253 }]));
    await withMulti({ app, replica }, async (client) => {
      const outcome = await callTool(client, 'mysql_list_databases', {});
      expect(outcome.isError).toBe(false);
      expect(app.calls).toHaveLength(1);
      expect(replica.calls).toHaveLength(0);
    });
  });

  it('指定 target 分派到对应源', async () => {
    const app = new FakeRunner(() => result([['a']], [{ name: 'c', type: 253 }]));
    const replica = new FakeRunner(() => result([['r']], [{ name: 'c', type: 253 }]));
    await withMulti({ app, replica }, async (client) => {
      const outcome = await callTool(client, 'mysql_list_databases', { target: 'replica' });
      expect(outcome.isError).toBe(false);
      expect(replica.calls).toHaveLength(1);
      expect(app.calls).toHaveLength(0);
    });
  });

  it('未知 target → PARAM', async () => {
    const app = new FakeRunner(() => result([], []));
    await withMulti({ app }, async (client) => {
      const outcome = await callTool(client, 'mysql_query', {
        target: 'ghost',
        sql: 'SELECT 1',
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.payload['code']).toBe(ErrorCode.PARAM);
      expect(app.calls).toHaveLength(0);
    });
  });

  it('每源覆盖生效：replica 的 maxRows/queryTimeoutMs 被采用', async () => {
    // app maxRows=1000；replica maxRows=3000
    const app = new FakeRunner(() => result([['1'], ['2']], [{ name: 'id', type: 8 }]));
    const replica = new FakeRunner(
      () => result([['1'], ['2'], ['3'], ['4']], [{ name: 'id', type: 8 }]),
    );
    await withMulti({ app, replica }, async (client) => {
      // 对 replica 请求 maxRows=2500（> app 的 1000，但 <= replica 的 3000）应成功
      const outcome = await callTool(client, 'mysql_query', {
        target: 'replica',
        sql: 'SELECT id FROM t',
        maxRows: 2500,
      });
      expect(outcome.isError).toBe(false);
      expect(outcome.payload['rowCount']).toBe(4); // 未超过 2500 不截断
      expect(replica.calls[0].timeoutMs).toBe(5000); // 该源 queryTimeoutMs
      // 缺省源 app 用自身 maxRows=1000，请求 2500 应 PARAM（每源上限）
      const outcome2 = await callTool(client, 'mysql_query', {
        sql: 'SELECT id FROM t',
        maxRows: 2500,
      });
      expect(outcome2.isError).toBe(true);
      expect(outcome2.payload['code']).toBe(ErrorCode.PARAM);
    });
  });

  it('写入按源 allowWrite：rw 可写、app 只读', async () => {
    const app = new FakeRunner(() => result([], []));
    const rw = new FakeRunner(
      () => result([], []),
      () => ({ affectedRows: 1, changedRows: 1, insertId: null }),
    );
    await withMulti({ app, rw }, async (client) => {
      // app（allowWrite=false）→ WRITE_DISABLED
      const dis = await callTool(client, 'mysql_execute', WRITE_OK);
      expect(dis.isError).toBe(true);
      expect(dis.payload['code']).toBe(ErrorCode.WRITE_DISABLED);
      // rw（allowWrite=true）→ 成功，且使用该源 maxAffectedRows=50
      const ok = await callTool(client, 'mysql_execute', { ...WRITE_OK, target: 'rw' });
      expect(ok.isError).toBe(false);
      expect(ok.payload['affectedRows']).toBe(1);
      expect(rw.writeCalls[0].maxAffectedRows).toBe(50);
      expect(app.writeCalls).toHaveLength(0);
    });
  });
});
