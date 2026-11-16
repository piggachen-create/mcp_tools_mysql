/**
 * 只读工具端到端单元测试：真实 McpServer + InMemoryTransport + 假 SqlRunner。
 * 覆盖 docs/testing-and-roadmap.md 第 4 节可单测部分（无外部 MySQL 依赖）。
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '../src/errors.js';
import { createServer } from '../src/server.js';
import type { QueryResult, SqlRunner } from '../src/pool.js';
import { FakeRunner, makeConfig, silentLogger } from './helpers.js';

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

async function withClient(
  runner: SqlRunner,
  fn: (client: Client, runner: FakeRunner) => Promise<void>,
  configOverrides: Record<string, unknown> = {},
): Promise<void> {
  const server = createServer({
    config: makeConfig(configOverrides),
    runner,
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await fn(client, runner as FakeRunner);
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
  it('默认仅注册 4 个只读工具', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(runner, async (client) => {
      const names = await listToolNames(client);
      expect(names).toEqual([
        'mysql_describe_table',
        'mysql_list_databases',
        'mysql_list_tables',
        'mysql_query',
      ]);
    });
  });

  it('allowWrite=true 时注册 5 个工具', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(
      runner,
      async (client) => {
        const names = await listToolNames(client);
        expect(names).toContain('mysql_execute');
        expect(names).toHaveLength(5);
      },
      { allowWrite: true },
    );
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
      // 走 information_schema 且带 LIMIT 参数
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
      result(
        [['a'], ['b'], ['c']],
        [{ name: 'table_name', type: 253 }],
      ),
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
  it('返回字段结构（默认库来自配置）', async () => {
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

  it('未指定 schema 且无默认库 → PARAM', async () => {
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
        // 拒绝发生在执行之前：不应触达数据库
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

describe('mysql_execute（M3 前占位）', () => {
  it('allowWrite=true 时返回 INTERNAL 占位错误', async () => {
    const runner = new FakeRunner(() => result([], []));
    await withClient(
      runner,
      async (client) => {
        const outcome = await callTool(client, 'mysql_execute', {
          sql: 'UPDATE users SET name = ? WHERE id = ?',
          params: ['x', 1],
        });
        expect(outcome.isError).toBe(true);
        expect(outcome.payload['code']).toBe(ErrorCode.INTERNAL);
      },
      { allowWrite: true },
    );
  });
});
