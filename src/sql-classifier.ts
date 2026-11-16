/**
 * SQL 分类器：基于 node-sql-parser 的 AST 分类，叠加危险特征检查。
 * 设计要求（docs/tool-contracts-and-security.md 第 6 节）：
 * - 不得用正则/字符串前缀判定语句类别；解析失败或无法确定性分类一律拒绝（fail-closed）。
 * - 多语句、锁定读取、INTO OUTFILE/DUMPFILE、用户变量副作用、危险函数、版本注释均不得绕过。
 * - classifyQuerySql 服务 mysql_query（只读白名单）；classifyExecuteSql 服务 mysql_execute（受控写入白名单）。
 */
import * as sqlParser from 'node-sql-parser';

/** 分类结论。 */
export interface QueryClassification {
  readonly ok: boolean;
  /** 脱敏拒绝原因（不含 SQL 正文），ok=false 时存在。 */
  readonly reason?: string;
  /** AST 中 ? 占位符个数（排除字符串字面量内的问号）。 */
  readonly placeholders: number;
}

/** AST 节点（宽松结构化访问）。 */
type AstNode = Record<string, unknown>;

/**
 * node-sql-parser 为 CJS 包且未导出 default：真实 ESM 运行时下命名空间导入
 * 需经 default 解包才能拿到 Parser（TS 类型层仍按命名导出解析）。
 */
type SqlParserCtor = new () => {
  astify(sql: string, opt: { database: string }): unknown;
};
function resolveParserCtor(): SqlParserCtor {
  const namespace = sqlParser as unknown as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const moduleExports = namespace.default ?? namespace;
  const ctor = moduleExports['Parser'];
  if (typeof ctor !== 'function') {
    throw new Error('node-sql-parser 加载失败：无法解析 Parser 构造器');
  }
  return ctor as SqlParserCtor;
}

const parser = new (resolveParserCtor())();

/** mysql_query 允许的顶层语句类别：SELECT / SHOW / EXPLAIN / DESCRIBE 子集。 */
const READ_ONLY_TYPES: ReadonlySet<string> = new Set([
  'select',
  'show',
  'desc',
  'explain',
]);

/** mysql_execute 允许的顶层语句类别：INSERT / UPDATE / DELETE（REPLACE 为独立 type，被白名单排除）。 */
const WRITE_TYPES: ReadonlySet<string> = new Set(['insert', 'update', 'delete']);

/** 拒绝名单函数（大小写不敏感；含文件读写与锁副作用）。 */
const BLACKLISTED_FUNCTIONS: ReadonlySet<string> = new Set([
  'SLEEP',
  'BENCHMARK',
  'LOAD_FILE',
  'GET_LOCK',
  'RELEASE_LOCK',
  'IS_FREE_LOCK',
  'IS_USED_LOCK',
]);

/** 版本注释 /*!NNNNN content *\/ → content：内容参与 AST 分类，防注释绕过。 */
const VERSION_COMMENT_RE = /\/\*!\d*([\s\S]*?)\*\//g;

function expandVersionComments(sql: string): string {
  return sql.replace(VERSION_COMMENT_RE, '$1');
}

function asNode(value: unknown): AstNode | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as AstNode;
}

/** 字段存在性（区分“未出现”与“显式 null”之外的真值）。 */
function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** 深度遍历 AST 全部对象/数组节点，带环保护。 */
function walk(
  node: unknown,
  visit: (node: AstNode) => void,
  seen: Set<object> = new Set(),
): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, seen);
    return;
  }
  const current = asNode(node);
  if (!current || seen.has(current)) return;
  seen.add(current);
  visit(current);
  for (const key of Object.keys(current)) walk(current[key], visit, seen);
}

/** 提取普通/聚合/窗口函数名（parser 保留原大小写，统一大写比较）。 */
function functionName(node: AstNode): string | undefined {
  // function / window：name 为 { name: [{ type, value }] }
  const name = asNode(node['name']);
  const parts = name && Array.isArray(name['name']) ? (name['name'] as unknown[]) : undefined;
  if (parts && parts.length > 0) {
    const first = asNode(parts[0]);
    if (typeof first?.['value'] === 'string') return first['value'].toUpperCase();
  }
  // aggr_func：name 为字符串
  if (typeof node['name'] === 'string') return node['name'].toUpperCase();
  return undefined;
}

/** 单语句解析结果：root 缺失时以 reason 说明拒绝原因。 */
interface ParsedStatement {
  readonly root?: AstNode;
  readonly reason?: string;
}

/** 解析并强制单语句：多语句/空语句/解析失败一律 fail-closed。 */
function parseSingleStatement(sql: string): ParsedStatement {
  let ast: unknown;
  try {
    ast = parser.astify(expandVersionComments(sql), { database: 'mysql' });
  } catch {
    return { reason: '无法解析为合法 SQL' };
  }
  // 数组返回：0=空语句、>1=多语句、1=单语句（尾分号）
  if (Array.isArray(ast)) {
    if (ast.length === 0) return { reason: '空语句' };
    if (ast.length > 1) return { reason: '多语句被拒绝' };
    ast = ast[0];
  }
  const root = asNode(ast);
  if (!root) return { reason: '空语句' };
  return { root };
}

/** 危险特征扫描 + ? 占位符计数（两个分类器共用；覆盖子查询/CTE/SET/VALUES 全部位置）。 */
function scanDangerFeatures(root: AstNode): {
  reason?: string;
  placeholders: number;
} {
  let placeholders = 0;
  let reason: string | undefined;
  walk(root, (node) => {
    if (reason !== undefined) return;
    const nodeType = typeof node['type'] === 'string' ? node['type'] : '';
    if (nodeType === 'select') {
      if (isPresent(node['locking_read'])) {
        reason = '锁定读取（FOR UPDATE / LOCK IN SHARE MODE）被拒绝';
        return;
      }
      const into = asNode(node['into']);
      if (into && isPresent(into['keyword'])) {
        reason = 'INTO 子句（OUTFILE/DUMPFILE/变量）被拒绝';
        return;
      }
    }
    if (nodeType === 'function' || nodeType === 'aggr_func' || nodeType === 'window') {
      const name = functionName(node);
      if (name !== undefined && BLACKLISTED_FUNCTIONS.has(name)) {
        reason = `拒绝名单函数（${name}）`;
        return;
      }
    }
    if (nodeType === 'assign') {
      reason = '用户变量赋值（:=）被拒绝';
      return;
    }
    if (nodeType === 'var' && node['prefix'] === '@') {
      // 单个 @ 为用户变量（跨语句状态）；@@ 系统变量只读放行
      reason = '用户变量被拒绝';
      return;
    }
    if (nodeType === 'origin' && node['value'] === '?') placeholders += 1;
  });
  return { reason, placeholders };
}

/** 断言表引用为单表：数组恰好 1 个元素且无 JOIN 标记（拒绝 JOIN/逗号多表）。 */
function singleTableRef(root: AstNode, key: string): boolean {
  const refs = root[key];
  if (!Array.isArray(refs) || refs.length !== 1) return false;
  const ref = asNode(refs[0]);
  if (!ref || isPresent(ref['join'])) return false;
  return true;
}

/** INSERT 形态检查：仅 INSERT INTO t (cols) VALUES (...)[,(...)]。 */
function checkInsertShape(root: AstNode): string | undefined {
  if (isPresent(root['on_duplicate_update'])) {
    return 'upsert（ON DUPLICATE KEY UPDATE）被拒绝';
  }
  const values = asNode(root['values']);
  if (!values || values['type'] !== 'values' || !Array.isArray(values['values'])) {
    // INSERT ... SELECT 的 values 为 { type: 'select', ... }，形态不同即拒绝
    return 'INSERT ... SELECT 被拒绝（仅允许 VALUES 形态）';
  }
  // 设计契约 4.2 节：显式列清单是允许形态的一部分（隐式列序依赖表结构，fail-closed 拒绝）
  if (!Array.isArray(root['columns']) || root['columns'].length === 0) {
    return 'INSERT 必须显式给出列清单';
  }
  if (!singleTableRef(root, 'table')) return '多表写入被拒绝';
  return undefined;
}

/** UPDATE 形态检查：单表、必须带 WHERE、不允许 ORDER BY/LIMIT 扩展形态。 */
function checkUpdateShape(root: AstNode): string | undefined {
  if (!singleTableRef(root, 'table')) return '多表写入被拒绝';
  if (!isPresent(root['where'])) return 'UPDATE 必须带 WHERE 条件';
  if (isPresent(root['orderby']) || isPresent(root['limit'])) {
    return '仅允许 UPDATE t SET ... WHERE ... 形态（不支持 ORDER BY/LIMIT）';
  }
  return undefined;
}

/** DELETE 形态检查：单表、必须带 WHERE、不允许 ORDER BY/LIMIT 扩展形态。 */
function checkDeleteShape(root: AstNode): string | undefined {
  if (!singleTableRef(root, 'from')) return '多表写入被拒绝';
  if (!isPresent(root['where'])) return 'DELETE 必须带 WHERE 条件';
  if (isPresent(root['orderby']) || isPresent(root['limit'])) {
    return '仅允许 DELETE FROM t WHERE ... 形态（不支持 ORDER BY/LIMIT）';
  }
  return undefined;
}

/**
 * 对单条 SQL 做只读白名单分类与危险特征检查。
 * 注意：分类结果不要求与外部并发状态一致，同一条 SQL 恒定返回相同结论。
 */
export function classifyQuerySql(sql: string): QueryClassification {
  // 标识符占位符 ?? 与 mysql2 文本协议回退路径语义冲突，直接拒绝
  if (sql.includes('??')) {
    return { ok: false, reason: '不支持标识符占位符', placeholders: 0 };
  }

  const { root, reason: parseReason } = parseSingleStatement(sql);
  if (!root) {
    return { ok: false, reason: parseReason ?? '无法解析为合法 SQL', placeholders: 0 };
  }

  const type = typeof root['type'] === 'string' ? root['type'] : '';
  if (!READ_ONLY_TYPES.has(type)) {
    return {
      ok: false,
      reason: `语句类别不在只读白名单（${type || '未知'}）`,
      placeholders: 0,
    };
  }

  const { reason, placeholders } = scanDangerFeatures(root);
  if (reason !== undefined) return { ok: false, reason, placeholders };
  return { ok: true, placeholders };
}

/**
 * 对单条 SQL 做受控写入白名单分类与危险特征检查（mysql_execute 专用）。
 * 允许形态（设计契约 4.2 节）：INSERT INTO t (cols) VALUES (...)（含多值）、
 * 带 WHERE 的单表 UPDATE/DELETE；其余一律拒绝（fail-closed）。
 */
export function classifyExecuteSql(sql: string): QueryClassification {
  if (sql.includes('??')) {
    return { ok: false, reason: '不支持标识符占位符', placeholders: 0 };
  }

  const { root, reason: parseReason } = parseSingleStatement(sql);
  if (!root) {
    return { ok: false, reason: parseReason ?? '无法解析为合法 SQL', placeholders: 0 };
  }

  const type = typeof root['type'] === 'string' ? root['type'] : '';
  if (!WRITE_TYPES.has(type)) {
    return {
      ok: false,
      reason: `语句类别不在写入白名单（${type || '未知'}）`,
      placeholders: 0,
    };
  }
  // WITH（CTE）不在允许写入形态内
  if (isPresent(root['with'])) {
    return { ok: false, reason: '写入语句不支持 WITH（CTE）', placeholders: 0 };
  }

  const shapeReason =
    type === 'insert'
      ? checkInsertShape(root)
      : type === 'update'
        ? checkUpdateShape(root)
        : checkDeleteShape(root);
  if (shapeReason !== undefined) {
    return { ok: false, reason: shapeReason, placeholders: 0 };
  }

  const { reason, placeholders } = scanDangerFeatures(root);
  if (reason !== undefined) return { ok: false, reason, placeholders };
  return { ok: true, placeholders };
}
