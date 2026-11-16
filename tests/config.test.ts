/**
 * 配置解析与 fail-fast 校验的单元测试矩阵。
 * 用例与 docs/testing-and-roadmap.md 第 2.1 节一一对应。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, type EnvSource } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

/** 最小合法环境变量集。 */
function baseEnv(overrides: EnvSource = {}): EnvSource {
  return {
    MYSQL_HOST: '127.0.0.1',
    MYSQL_USER: 'mcp_ro',
    MYSQL_PASSWORD: 'secret-password',
    ...overrides,
  };
}

describe('配置解析：全部有效与默认值', () => {
  it('仅提供必填项时解析成功且默认值正确', () => {
    const config = loadConfig(baseEnv());
    expect(config.host).toBe('127.0.0.1');
    expect(config.user).toBe('mcp_ro');
    expect(config.password).toBe('secret-password');
    expect(config.port).toBe(3306);
    expect(config.database).toBe('');
    expect(config.charset).toBe('utf8mb4');
    expect(config.connectTimeoutMs).toBe(10000);
    expect(config.poolSize).toBe(5);
    expect(config.poolIdleTimeoutMs).toBe(60000);
    expect(config.queryTimeoutMs).toBe(30000);
    expect(config.maxRows).toBe(1000);
    expect(config.sqlMaxLength).toBe(16384);
    expect(config.maxParams).toBe(500);
    expect(config.maxAffectedRows).toBe(1000);
    expect(config.tls).toBe(false);
    expect(config.tlsRejectUnauthorized).toBe(true);
    expect(config.allowWrite).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('显式提供的合法值覆盖默认值', () => {
    const config = loadConfig(
      baseEnv({
        MYSQL_PORT: '3307',
        MYSQL_MAX_ROWS: '5000',
        MYSQL_ALLOW_WRITE: 'true',
        MYSQL_LOG_LEVEL: 'warn',
      }),
    );
    expect(config.port).toBe(3307);
    expect(config.maxRows).toBe(5000);
    expect(config.allowWrite).toBe(true);
    expect(config.logLevel).toBe('warn');
  });
});

describe('配置解析：fail-fast 用例', () => {
  it('密码缺失时抛出 ConfigError', () => {
    const env = baseEnv();
    delete env['MYSQL_PASSWORD'];
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('主机缺失时抛出 ConfigError', () => {
    const env = baseEnv();
    delete env['MYSQL_HOST'];
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it.each(['0', '70000', '-1'])('端口越界 %s 时 fail-fast', (port) => {
    expect(() => loadConfig(baseEnv({ MYSQL_PORT: port }))).toThrow(
      ConfigError,
    );
  });

  it.each(['1', '0', 'yes', 'no', 'on', 'off', ''])(
    '布尔值非标准写法 MYSQL_TLS=%s 时 fail-fast',
    (value) => {
      expect(() => loadConfig(baseEnv({ MYSQL_TLS: value }))).toThrow(
        ConfigError,
      );
    },
  );

  it('布尔值大小写不敏感：True/FALSE 均可解析', () => {
    expect(loadConfig(baseEnv({ MYSQL_ALLOW_WRITE: 'True' })).allowWrite).toBe(
      true,
    );
    expect(loadConfig(baseEnv({ MYSQL_TLS: 'FALSE' })).tls).toBe(false);
  });

  it.each(['0', '10001'])('MYSQL_MAX_ROWS 越界 %s 时 fail-fast', (value) => {
    expect(() => loadConfig(baseEnv({ MYSQL_MAX_ROWS: value }))).toThrow(
      ConfigError,
    );
  });

  it('数值非数字（MYSQL_POOL_SIZE=abc）时 fail-fast', () => {
    expect(() => loadConfig(baseEnv({ MYSQL_POOL_SIZE: 'abc' }))).toThrow(
      ConfigError,
    );
  });

  it('浮点数值（MYSQL_POOL_SIZE=2.5）时 fail-fast', () => {
    expect(() => loadConfig(baseEnv({ MYSQL_POOL_SIZE: '2.5' }))).toThrow(
      ConfigError,
    );
  });

  it('时间单位低于下限（MYSQL_QUERY_TIMEOUT_MS=50）时 fail-fast', () => {
    expect(() =>
      loadConfig(baseEnv({ MYSQL_QUERY_TIMEOUT_MS: '50' })),
    ).toThrow(ConfigError);
  });

  it('时间单位高于上限（MYSQL_QUERY_TIMEOUT_MS=300001）时 fail-fast', () => {
    expect(() =>
      loadConfig(baseEnv({ MYSQL_QUERY_TIMEOUT_MS: '300001' })),
    ).toThrow(ConfigError);
  });

  it('日志级别非法（verbose）时 fail-fast', () => {
    expect(() =>
      loadConfig(baseEnv({ MYSQL_LOG_LEVEL: 'verbose' })),
    ).toThrow(ConfigError);
  });
});
