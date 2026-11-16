/**
 * 序列化与错误映射单元测试：对应 docs/testing-and-roadmap.md 第 3 节与错误码模型。
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../src/errors.js';
import { mapMySqlError } from '../src/error-mapper.js';
import { MYSQL_TYPE, serializeRows, serializeValue } from '../src/serializer.js';
import { silentLogger } from './helpers.js';

describe('serializeValue：契约第 5 节语义', () => {
  it('NULL 保持 null', () => {
    expect(serializeValue(null, MYSQL_TYPE.LONGLONG)).toBeNull();
  });
  it('BIGINT 大整数以字符串保精度', () => {
    expect(serializeValue('9223372036854775807', MYSQL_TYPE.LONGLONG)).toBe('9223372036854775807');
  });
  it('DECIMAL 以字符串保精度', () => {
    expect(serializeValue('1234.567890123456789', MYSQL_TYPE.NEWDECIMAL)).toBe('1234.567890123456789');
  });
  it('整数/浮点返回 number', () => {
    expect(serializeValue(42, MYSQL_TYPE.LONG)).toBe(42);
    expect(serializeValue(1.5, MYSQL_TYPE.DOUBLE)).toBe(1.5);
  });
  it('DATETIME 返回驱动原样字符串', () => {
    expect(serializeValue('2026-11-16 12:30:00', MYSQL_TYPE.DATETIME)).toBe('2026-11-16 12:30:00');
  });
  it('二进制转 base64', () => {
    expect(serializeValue(Buffer.from([0x00, 0xff]), MYSQL_TYPE.BLOB)).toBe('AP8=');
  });
  it('BIT 转位序列字符串（去高位补零）', () => {
    expect(serializeValue(Buffer.from([0x0a]), MYSQL_TYPE.BIT)).toBe('1010');
  });
  it('BIT 全零返回 "0"', () => {
    expect(serializeValue(Buffer.from([0x00]), MYSQL_TYPE.BIT)).toBe('0');
  });
  it('JSON 文本原样字符串', () => {
    expect(serializeValue('{"a":1}', MYSQL_TYPE.JSON)).toBe('{"a":1}');
  });
  it('对象值尽力返回 JSON 文本', () => {
    expect(serializeValue({ a: 1 }, MYSQL_TYPE.JSON)).toBe('{"a":1}');
  });
  it('非有限数值以字符串尽力返回（JSON 不允许 Infinity）', () => {
    expect(serializeValue(Number.POSITIVE_INFINITY, MYSQL_TYPE.DOUBLE)).toBe('Infinity');
  });
  it('bigint 运行时值转字符串', () => {
    expect(serializeValue(9223372036854775807n, MYSQL_TYPE.LONGLONG)).toBe('9223372036854775807');
  });
});

describe('serializeRows：行数截断与列元数据', () => {
  const fields = [
    { name: 'id', type: MYSQL_TYPE.LONGLONG },
    { name: 'name', type: MYSQL_TYPE.VAR_STRING },
    { name: 'balance', type: MYSQL_TYPE.NEWDECIMAL },
  ];
  const rows = [
    ['1', 'alice', '1234.56'],
    ['2', 'bob', '7.89'],
  ];

  it('完整返回且不截断', () => {
    const result = serializeRows(rows, fields, 100);
    expect(result.columns).toEqual(['id', 'name', 'balance']);
    expect(result.columnTypes).toEqual(['bigint', 'varchar', 'decimal']);
    expect(result.rows).toEqual([['1', 'alice', '1234.56'], ['2', 'bob', '7.89']]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('超过 maxRows 截断并置 truncated=true', () => {
    const result = serializeRows([...rows, ['3', 'carol', '0.1']], fields, 2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  it('未知类型码输出 unknown', () => {
    const result = serializeRows([[1]], [{ name: 'x', type: 999 }], 10);
    expect(result.columnTypes).toEqual(['unknown']);
  });
});

describe('mapMySqlError：稳定错误码映射', () => {
  const logger = silentLogger();

  it('网络/认证错误 → CONNECTION', () => {
    expect(mapMySqlError({ code: 'ECONNREFUSED' }, logger).code).toBe(ErrorCode.CONNECTION);
    expect(mapMySqlError({ code: 'ER_ACCESS_DENIED_ERROR' }, logger).code).toBe(ErrorCode.CONNECTION);
  });
  it('查询超时 → TIMEOUT', () => {
    expect(mapMySqlError({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' }, logger).code).toBe(ErrorCode.TIMEOUT);
  });
  it('表不存在等语义错误 → PARAM', () => {
    expect(mapMySqlError({ code: 'ER_NO_SUCH_TABLE' }, logger).code).toBe(ErrorCode.PARAM);
    expect(mapMySqlError({ code: 'ER_PARSE_ERROR' }, logger).code).toBe(ErrorCode.PARAM);
  });
  it('数据库权限拒绝 → POLICY_REJECTED（权限兜底）', () => {
    expect(mapMySqlError({ code: 'ER_TABLEACCESS_DENIED_ERROR' }, logger).code).toBe(
      ErrorCode.POLICY_REJECTED,
    );
  });
  it('未识别错误 → INTERNAL', () => {
    expect(mapMySqlError({ code: 'ER_WHATEVER_NEW' }, logger).code).toBe(ErrorCode.INTERNAL);
    expect(mapMySqlError(new Error('boom'), logger).code).toBe(ErrorCode.INTERNAL);
  });
  it('ToolError 原样透传', () => {
    const err = mapMySqlError(
      // 构造一个已映射错误验证透传
      { code: 'ER_NO_SUCH_TABLE' },
      logger,
    );
    expect(mapMySqlError(err, logger)).toBe(err);
  });
  it('客户端消息恒定脱敏（不含 SQL 与原始报错）', () => {
    const mapped = mapMySqlError({ code: 'ER_NO_SUCH_TABLE', message: "Table 'app.x' doesn't exist" }, logger);
    expect(mapped.message).not.toContain("doesn't exist");
    expect(mapped.message).toBe('SQL 语句或参数不被数据库接受');
  });
});
