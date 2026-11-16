/**
 * SQL 只读分类器：基于 node-sql-parser 的 AST 分类，叠加危险特征检查。
 * 设计要求（docs/tool-contracts-and-security.md 第 6 节）：
 * - 不得用正则/字符串前缀判定语句类别；解析失败或无法确定性分类一律拒绝（fail-closed）。
 * - 多语句、锁定读取、INTO OUTFILE/DUMPFILE、用户变量副作用、危险函数、版本注释均不得绕过。
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

/**
 * 对单条 SQL 做只读白名单分类与危险特征检查。
 * 注意：分类结果不要求与外部并发状态一致，同一条 SQL 恒定返回相同结论。
 */
export function classifyQuerySql(sql: string): QueryClassification {
  // 标识符占位符 ?? 与 mysql2 文本协议回退路径语义冲突，直接拒绝
  if (sql.includes('??')) {
    return { ok: false, reason: '不支持标识符占位符', placeholders: 0 };
  }

  let ast: unknown;
  try {
    ast = parser.astify(expandVersionComments(sql), { database: 'mysql' });
  } catch {
    return { ok: false, reason: '无法解析为合法 SQL', placeholders: 0 };
  }

  // 数组返回：0=空语句、>1=多语句、1=单语句（尾分号）
  if (Array.isArray(ast)) {
    if (ast.length === 0) return { ok: false, reason: '空语句', placeholders: 0 };
    if (ast.length > 1) return { ok: false, reason: '多语句被拒绝', placeholders: 0 };
    ast = ast[0];
  }
  const root = asNode(ast);
  if (!root) return { ok: false, reason: '空语句', placeholders: 0 };

  const type = typeof root['type'] === 'string' ? root['type'] : '';
  if (!READ_ONLY_TYPES.has(type)) {
    return {
      ok: false,
      reason: `语句类别不在只读白名单（${type || '未知'}）`,
      placeholders: 0,
    };
  }

  // 危险特征检查 + 占位符计数（遍历整棵 AST，覆盖子查询/CTE/EXPLAIN 内嵌语句）
  let placeholders = 0;
  let reason: string | undefined;
  walk(root, (node) => {
    if (reason !== undefined) return;
    const nodeType = typeof node['type'] === 'string' ? node['type'] : '';
    if (nodeType === 'select') {
      if (node['locking_read'] !== null && node['locking_read'] !== undefined) {
        reason = '锁定读取（FOR UPDATE / LOCK IN SHARE MODE）被拒绝';
        return;
      }
      const into = asNode(node['into']);
      if (into && into['keyword'] !== null && into['keyword'] !== undefined) {
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

  if (reason !== undefined) return { ok: false, reason, placeholders };
  return { ok: true, placeholders };
}
