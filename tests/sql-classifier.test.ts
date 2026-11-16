/**
 * SQL 分类器单元测试：对应 docs/testing-and-roadmap.md 第 2.2 节矩阵与第 6 节 S 类用例。
 */
import { describe, expect, it } from 'vitest';
import { classifyQuerySql } from '../src/sql-classifier.js';

const ALLOWED: ReadonlyArray<{ sql: string; placeholders?: number }> = [
  { sql: 'SELECT a FROM t WHERE id=?', placeholders: 1 },
  { sql: 'WITH c AS (SELECT 1) SELECT * FROM c' },
  { sql: 'sElEcT * FrOm t' },
  { sql: 'SELECT\n *\n FROM\tt' },
  { sql: '-- hi\nSELECT * FROM t' },
  { sql: '/*x*/ SELECT 1' },
  { sql: 'SELECT # comment\n1' },
  { sql: '/*!50000 SELECT 1 */' },
  { sql: 'SELECT 1;' }, // 尾分号：单语句
  { sql: 'SHOW TABLES' },
  { sql: 'SHOW DATABASES' },
  { sql: 'SHOW CREATE TABLE `users`' },
  { sql: 'SHOW PROCESSLIST' },
  { sql: 'EXPLAIN SELECT * FROM t' },
  { sql: 'DESCRIBE t' },
  { sql: 'DESC users' },
  { sql: 'SELECT 1 UNION SELECT 2' },
  { sql: 'SELECT 1 UNION ALL SELECT 2' },
  { sql: 'SELECT @@version' }, // 系统变量只读放行
  { sql: 'SELECT * FROM v, (SELECT 1) AS x' },
  { sql: 'SELECT * FROM t WHERE a=? AND b=?', placeholders: 2 },
  { sql: 'SELECT ROW_NUMBER() OVER () FROM t' },
  { sql: 'SELECT ? AS y', placeholders: 1 },
  {
    sql: 'SELECT id, name FROM users WHERE status = ? ORDER BY id LIMIT 5',
    placeholders: 1,
  },
];

const REJECTED: ReadonlyArray<{ sql: string; reasonIncludes?: string }> = [
  // 锁定读取（S4）
  { sql: 'SELECT * FROM t WHERE id = 1 FOR UPDATE', reasonIncludes: '锁定读取' },
  { sql: 'SELECT * FROM t WHERE id = 1 LOCK IN SHARE MODE', reasonIncludes: '锁定读取' },
  // 文件输出（S5）
  { sql: "SELECT * INTO OUTFILE '/tmp/x.csv' FROM t", reasonIncludes: 'INTO' },
  { sql: "SELECT * FROM t INTO DUMPFILE '/tmp/x'", reasonIncludes: 'INTO' },
  { sql: 'SELECT 1 INTO @v', reasonIncludes: 'INTO' },
  // 用户变量副作用（S12）
  { sql: 'SELECT @x := 1', reasonIncludes: '变量' },
  { sql: 'SELECT (SELECT @x := id FROM t LIMIT 1) AS v', reasonIncludes: '变量' },
  { sql: 'SELECT @a', reasonIncludes: '变量' },
  // 危险函数（S11）
  { sql: 'SELECT SLEEP(10)', reasonIncludes: '拒绝名单' },
  { sql: 'SELECT sleep(10)', reasonIncludes: '拒绝名单' },
  { sql: "SELECT BENCHMARK(1000000, SHA1('test'))", reasonIncludes: '拒绝名单' },
  { sql: "SELECT LOAD_FILE('/etc/passwd')", reasonIncludes: '拒绝名单' },
  { sql: "SELECT GET_LOCK('k', 1)", reasonIncludes: '拒绝名单' },
  { sql: 'SELECT * FROM t WHERE id IN (SELECT SLEEP(10))', reasonIncludes: '拒绝名单' },
  // 多语句（S1/S2）
  { sql: 'SELECT 1; DROP TABLE t', reasonIncludes: '多语句' },
  { sql: 'SELECT 1 -- hidden\n; DROP TABLE t', reasonIncludes: '多语句' },
  { sql: 'UPDATE t SET a=? WHERE id=?; SELECT 1', reasonIncludes: '多语句' },
  // 版本注释携带危险语句（S3）：内容参与分类
  { sql: "/*!50000 SELECT * FROM t FOR UPDATE */", reasonIncludes: '锁定读取' },
  { sql: "/*!50000 SELECT * INTO OUTFILE '/tmp/x' FROM t */", reasonIncludes: 'INTO' },
  { sql: '/*!50000 SELECT 1; DROP TABLE t */', reasonIncludes: '多语句' },
  // 写语句一律拒绝（query 语义）
  { sql: 'INSERT INTO t (a) VALUES (?)' },
  { sql: 'INSERT INTO a SELECT * FROM b' },
  { sql: 'REPLACE INTO t VALUES (1)' },
  { sql: 'UPDATE t SET a=? WHERE id=?' },
  { sql: 'DELETE FROM t WHERE id=?' },
  // DDL / DCL / TCL / 其它
  { sql: 'DROP TABLE t' },
  { sql: 'ALTER TABLE t ADD COLUMN c INT' },
  { sql: 'TRUNCATE TABLE t' },
  { sql: 'GRANT SELECT ON *.* TO u' },
  { sql: 'BEGIN' },
  { sql: 'COMMIT' },
  { sql: 'SET autocommit=1' },
  { sql: 'SET @a = 1' },
  { sql: 'USE app' },
  { sql: 'CALL p()' },
  { sql: "PREPARE s FROM 'SELECT 1'" },
  { sql: 'LOCK TABLES t READ' },
  // 解析失败 / 非法输入
  { sql: 'not valid sql (((', reasonIncludes: '无法解析' },
  { sql: '' },
  { sql: '-- only a comment\n' },
  { sql: 'SELECT a ?? b FROM t', reasonIncludes: '标识符占位符' },
  // 解析器不支持的语句形态（fail-closed）
  { sql: 'SHOW FULL TABLES FROM app' },
  { sql: 'EXPLAIN ANALYZE SELECT * FROM t' },
  { sql: 'TABLE t' },
  { sql: 'SHOW VARIABLES LIKE \'max%\'' },
];

describe('classifyQuerySql：只读白名单', () => {
  for (const { sql, placeholders } of ALLOWED) {
    it(`放行 ${JSON.stringify(sql)}`, () => {
      const result = classifyQuerySql(sql);
      expect(result.ok).toBe(true);
      if (placeholders !== undefined) expect(result.placeholders).toBe(placeholders);
    });
  }
});

describe('classifyQuerySql：策略拒绝（fail-closed）', () => {
  for (const { sql, reasonIncludes } of REJECTED) {
    it(`拒绝 ${JSON.stringify(sql.slice(0, 60))}`, () => {
      const result = classifyQuerySql(sql);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
      if (reasonIncludes !== undefined) {
        expect(result.reason).toContain(reasonIncludes);
      }
    });
  }
});

describe('classifyQuerySql：稳定性', () => {
  it('同一条 SQL 多次分类结果恒定', () => {
    for (const sql of ['SELECT * FROM t', 'SELECT * FROM t FOR UPDATE']) {
      const first = classifyQuerySql(sql);
      const second = classifyQuerySql(sql);
      expect(second).toEqual(first);
    }
  });
});
