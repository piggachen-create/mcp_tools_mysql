/**
 * 多数据源配置解析与 fail-fast 校验的单元测试矩阵。
 * 用例与 docs/testing-and-roadmap.md 多源配置矩阵对应。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSourcesConfig, type EnvSource } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

/** 创建临时配置文件并返回路径。 */
function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  const file = join(dir, 'mcp.sources.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

/** 简洁单/多源 JSON 构造工具。 */
function json(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

describe('多源配置解析：合并与默认值', () => {
  it('global 提供默认、source 覆盖；defaultTarget 缺省取首源', () => {
    const file = tempFile(
      json({
        global: { poolSize: 3, maxRows: 2000, allowWrite: false },
        sources: [
          {
            target: 'app',
            host: 'db1',
            user: 'ro',
            password: 'p1',
            database: 'app',
          },
          {
            target: 'rw',
            host: 'db2',
            user: 'rw',
            password: 'p2',
            allowWrite: true,
          },
        ],
      }),
    );
    const cfg = loadSourcesConfig({ file });
    expect(cfg.global.defaultTarget).toBe('app');
    expect(cfg.global.poolSize).toBe(3);
    // app 未覆盖：取 global 的 maxRows=2000
    expect(cfg.sources[0].maxRows).toBe(2000);
    expect(cfg.sources[0].allowWrite).toBe(false);
    // rw 覆盖 allowWrite=true，maxRows 仍取 global=2000
    expect(cfg.sources[1].allowWrite).toBe(true);
    expect(cfg.sources[1].maxRows).toBe(2000);
  });

  it('source 显式值优先于 global，不写任何 global 时用内置默认', () => {
    const file = tempFile(
      json({
        sources: [
          {
            target: 'a',
            host: 'h',
            user: 'u',
            password: 'p',
            // 未写 database —— 应回落内置默认 ''
            queryTimeoutMs: 5000,
          },
        ],
      }),
    );
    const cfg = loadSourcesConfig({ file });
    expect(cfg.sources[0].queryTimeoutMs).toBe(5000); // 显式
    expect(cfg.sources[0].database).toBe(''); // 内置默认
    expect(cfg.sources[0].maxRows).toBe(1000); // 内置默认
    expect(cfg.sources[0].port).toBe(3306); // 内置默认
  });

  it('defaultTarget 显式声明指向非首位源', () => {
    const file = tempFile(
      json({
        defaultTarget: 'replica',
        sources: [
          { target: 'app', host: 'a', user: 'u', password: 'p' },
          { target: 'replica', host: 'b', user: 'u', password: 'p' },
        ],
      }),
    );
    expect(loadSourcesConfig({ file }).global.defaultTarget).toBe('replica');
  });

  it('密码支持 ${VAR} 环境变量引用展开', () => {
    const file = tempFile(
      json({
        sources: [{ target: 'a', host: 'h', user: 'u', password: '${MYSQL_SECRET}' }],
      }),
    );
    const cfg = loadSourcesConfig({ file, env: { MYSQL_SECRET: 'real-s3cr3t' } });
    expect(cfg.sources[0].password).toBe('real-s3cr3t');
  });

  it('MCP_SOURCES_FILE 环境变量指定路径', () => {
    const file = tempFile(
      json({ sources: [{ target: 'a', host: 'h', user: 'u', password: 'p' }] }),
    );
    const cfg = loadSourcesConfig({ env: { MCP_SOURCES_FILE: file } as EnvSource });
    expect(cfg.sources[0].target).toBe('a');
  });
});

describe('多源配置解析：fail-fast 用例', () => {
  it('sources 缺失时 fail-fast', () => {
    const file = tempFile(json({ global: {} }));
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('sources 为空数组时 fail-fast', () => {
    const file = tempFile(json({ sources: [] }));
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('文件不存在时 fail-fast', () => {
    expect(() => loadSourcesConfig({ file: join(tmpdir(), 'nope-mcp.json') })).toThrow(
      ConfigError,
    );
  });

  it('非合法 JSON 时 fail-fast', () => {
    const file = tempFile('not json { ');
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('存在重复 target 时 fail-fast', () => {
    const file = tempFile(
      json({
        sources: [
          { target: 'a', host: 'h', user: 'u', password: 'p' },
          { target: 'a', host: 'h2', user: 'u2', password: 'p2' },
        ],
      }),
    );
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it.each(['bad target!', 'a/b', 'toolong-' + 'a'.repeat(70), '反引号`'])(
    '非法 target 字符/长度 %s 时 fail-fast',
    (target) => {
      const file = tempFile(
        json({ sources: [{ target, host: 'h', user: 'u', password: 'p' }] }),
      );
      expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
    },
  );

  it('合法 target（含下划线/连字符/数字）可解析', () => {
    const file = tempFile(
      json({ sources: [{ target: 'app-1_replica', host: 'h', user: 'u', password: 'p' }] }),
    );
    expect(loadSourcesConfig({ file }).sources[0].target).toBe('app-1_replica');
  });

  it('连接参数缺失（host/user/password）时 fail-fast', () => {
    const file = tempFile(json({ sources: [{ target: 'a', host: 'h' }] }));
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('defaultTarget 指向不存在源时 fail-fast', () => {
    const file = tempFile(
      json({
        defaultTarget: 'ghost',
        sources: [{ target: 'a', host: 'h', user: 'u', password: 'p' }],
      }),
    );
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('全局专属字段出现在 source 内时 fail-fast', () => {
    const file = tempFile(
      json({
        sources: [
          { target: 'a', host: 'h', user: 'u', password: 'p', poolSize: 9 },
        ],
      }),
    );
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('连接参数出现在 global 内时 fail-fast', () => {
    const file = tempFile(
      json({
        global: { host: 'bad' },
        sources: [{ target: 'a', host: 'h', user: 'u', password: 'p' }],
      }),
    );
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('${VAR} 引用环境变量缺失时 fail-fast', () => {
    const file = tempFile(
      json({
        sources: [{ target: 'a', host: 'h', user: 'u', password: '${MISSING}' }],
      }),
    );
    expect(() => loadSourcesConfig({ file, env: {} })).toThrow(ConfigError);
  });

  it('数值越界（queryTimeoutMs=50）时 fail-fast', () => {
    const file = tempFile(
      json({
        sources: [{ target: 'a', host: 'h', user: 'u', password: 'p', queryTimeoutMs: 50 }],
      }),
    );
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('布尔值非标准写法（allowWrite=1）时 fail-fast', () => {
    const file = tempFile(
      json({
        sources: [{ target: 'a', host: 'h', user: 'u', password: 'p', allowWrite: '1' }],
      }),
    );
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });

  it('日志级别非法（verbose）时 fail-fast', () => {
    const file = tempFile(
      json({
        global: { logLevel: 'verbose' },
        sources: [{ target: 'a', host: 'h', user: 'u', password: 'p' }],
      }),
    );
    expect(() => loadSourcesConfig({ file })).toThrow(ConfigError);
  });
});
