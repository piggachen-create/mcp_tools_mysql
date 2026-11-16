/**
 * SQL 分类器单元测试：对应 docs/testing-and-roadmap.md 第 2.2 节矩阵与第 6 节 S 类用例。
 * classifyQuerySql 覆盖只读白名单；classifyExecuteSql 覆盖受控写入白名单（M3）。
 */
import { describe, expect, it } from 'vitest';
import { classifyExecuteSql, classifyQuerySql } from '../src/sql-classifier.js';

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

// ---------- classifyExecuteSql：受控写入白名单（M3，设计契约 4.2 节） ----------

const EXECUTE_ALLOWED: ReadonlyArray<{ sql: string; placeholders?: number }> = [
  { sql: 'INSERT INTO t (a) VALUES (?)', placeholders: 1 },
  { sql: 'INSERT INTO t (a, b) VALUES (?, ?)', placeholders: 2 },
  { sql: 'INSERT INTO t (a) VALUES (?), (?)', placeholders: 2 },
  { sql: 'INSERT INTO t (a) VALUES (?), (?), (?)', placeholders: 3 },
  { sql: 'insert into t (a) values (?)' },
  { sql: "INSERT INTO t (a) VALUES ('x')", placeholders: 0 },
  { sql: 'UPDATE t SET a=? WHERE id=?', placeholders: 2 },
  { sql: 'update t set a=? where id=?' },
  { sql: 'UPDATE db.t SET a = ? WHERE id IN (?, ?)', placeholders: 3 },
  { sql: 'DELETE FROM t WHERE id=?', placeholders: 1 },
  { sql: 'DELETE FROM db.t WHERE id = ?', placeholders: 1 },
  { sql: 'INSERT INTO t (a) VALUES (?);' },
  { sql: '-- hi\nINSERT INTO t (a) VALUES (?)' },
  { sql: '/*x*/ UPDATE t SET a=? WHERE id=?' },
  { sql: '/*!50000 UPDATE t SET a=? WHERE id=? */' },
  { sql: 'UPDATE\n t\n SET a=?\n WHERE id=?' },
];

const EXECUTE_REJECTED: ReadonlyArray<{ sql: string; reasonIncludes?: string }> = [
  // 无 WHERE 写入（S6）
  { sql: 'UPDATE t SET a=?', reasonIncludes: 'WHERE' },
  { sql: 'DELETE FROM t', reasonIncludes: 'WHERE' },
  // 多表写入（S7）
  { sql: 'UPDATE a JOIN b ON a.id = b.id SET a.x=? WHERE a.id=?', reasonIncludes: '多表' },
  { sql: 'UPDATE a, b SET a.x=? WHERE a.id=?', reasonIncludes: '多表' },
  { sql: 'DELETE a FROM a JOIN b WHERE a.id=?', reasonIncludes: '多表' },
  { sql: 'DELETE FROM a USING b WHERE a.id=?' },
  // INSERT 扩展形态
  { sql: 'INSERT INTO a SELECT * FROM b', reasonIncludes: 'SELECT' },
  { sql: 'INSERT INTO a (x) SELECT y FROM b WHERE z=?', reasonIncludes: 'SELECT' },
  { sql: 'REPLACE INTO t (a) VALUES (?)', reasonIncludes: '白名单' },
  { sql: 'INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a=?', reasonIncludes: 'upsert' },
  { sql: 'INSERT INTO t VALUES (?)', reasonIncludes: '列清单' },
  // ORDER BY / LIMIT 扩展形态（不在允许表单内）
  { sql: 'UPDATE t SET a=? WHERE id=? ORDER BY id LIMIT 10' },
  { sql: 'DELETE FROM t WHERE id=? LIMIT 10' },
  // CTE 写入
  { sql: 'WITH c AS (SELECT 1) UPDATE t SET a=? WHERE id=?' },
  // 只读语句（execute 语义下拒绝）
  { sql: 'SELECT 1', reasonIncludes: '白名单' },
  { sql: 'SHOW TABLES', reasonIncludes: '白名单' },
  { sql: 'EXPLAIN SELECT * FROM t', reasonIncludes: '白名单' },
  { sql: 'SELECT * FROM t WHERE id=1 FOR UPDATE', reasonIncludes: '白名单' },
  // DDL / DCL / TCL / 其它
  { sql: 'DROP TABLE t', reasonIncludes: '白名单' },
  { sql: 'TRUNCATE TABLE t', reasonIncludes: '白名单' },
  { sql: 'ALTER TABLE t ADD COLUMN c INT', reasonIncludes: '白名单' },
  { sql: 'CREATE TABLE t (a INT)', reasonIncludes: '白名单' },
  { sql: 'GRANT SELECT ON *.* TO u', reasonIncludes: '白名单' },
  { sql: 'BEGIN', reasonIncludes: '白名单' },
  { sql: 'COMMIT', reasonIncludes: '白名单' },
  { sql: 'CALL p()', reasonIncludes: '白名单' },
  { sql: 'SET autocommit=1', reasonIncludes: '白名单' },
  { sql: 'USE app', reasonIncludes: '白名单' },
  { sql: 'LOCK TABLES t WRITE', reasonIncludes: '白名单' },
  // 危险特征（对写入同样生效）
  { sql: 'INSERT INTO t (a) VALUES (SLEEP(1))', reasonIncludes: '拒绝名单' },
  { sql: 'INSERT INTO t (a) VALUES (BENCHMARK(1, 1))', reasonIncludes: '拒绝名单' },
  { sql: "INSERT INTO t (a) VALUES (LOAD_FILE('/etc/passwd'))", reasonIncludes: '拒绝名单' },
  { sql: 'UPDATE t SET a = (SELECT SLEEP(1)) WHERE id=?', reasonIncludes: '拒绝名单' },
  // 多语句（S1/S2）
  { sql: 'UPDATE t SET a=? WHERE id=?; DROP TABLE t', reasonIncludes: '多语句' },
  { sql: 'INSERT INTO t (a) VALUES (?); SELECT 1', reasonIncludes: '多语句' },
  { sql: 'DELETE FROM t WHERE id=? -- hidden\n; DROP TABLE t', reasonIncludes: '多语句' },
  // 版本注释携带危险语句（S3）：内容参与分类
  { sql: '/*!50000 DROP TABLE t */', reasonIncludes: '白名单' },
  { sql: '/*!50000 UPDATE t SET a=1 */', reasonIncludes: 'WHERE' },
  { sql: '/*!50000 INSERT INTO t (a) VALUES (1); DROP TABLE t */', reasonIncludes: '多语句' },
  // 用户变量 / 标识符占位符（解析失败或变量检查均属 fail-closed 拒绝）
  { sql: 'UPDATE t SET a = @x WHERE id=?' },
  { sql: 'UPDATE t SET a = @x := 1 WHERE id=?', reasonIncludes: '无法解析' },
  // 解析失败 / 非法输入
  { sql: 'not valid sql (((', reasonIncludes: '无法解析' },
  { sql: '' },
  { sql: '   ' },
  { sql: '-- only a comment\n' },
];

describe('classifyExecuteSql：写入白名单', () => {
  for (const { sql, placeholders } of EXECUTE_ALLOWED) {
    it(`放行 ${JSON.stringify(sql)}`, () => {
      const result = classifyExecuteSql(sql);
      expect(result.ok).toBe(true);
      if (placeholders !== undefined) expect(result.placeholders).toBe(placeholders);
    });
  }

  it('放行语句的占位符计数准确', () => {
    const result = classifyExecuteSql(
      'INSERT INTO t (a, b) VALUES (?, ?), (?, ?)',
    );
    expect(result.placeholders).toBe(4);
  });
});

describe('classifyExecuteSql：策略拒绝（fail-closed）', () => {
  for (const { sql, reasonIncludes } of EXECUTE_REJECTED) {
    it(`拒绝 ${JSON.stringify(sql.slice(0, 60))}`, () => {
      const result = classifyExecuteSql(sql);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
      if (reasonIncludes !== undefined) {
        expect(result.reason).toContain(reasonIncludes);
      }
    });
  }
});

describe('两分类器互斥', () => {
  it('只读语句不被写入分类器放行、写入语句不被只读分类器放行', () => {
    expect(classifyQuerySql('SELECT 1').ok).toBe(true);
    expect(classifyExecuteSql('SELECT 1').ok).toBe(false);
    expect(classifyExecuteSql('UPDATE t SET a=? WHERE id=?').ok).toBe(true);
    expect(classifyQuerySql('UPDATE t SET a=? WHERE id=?').ok).toBe(false);
  });
});
