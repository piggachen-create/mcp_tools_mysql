/**
 * ConnectionManager 多池注册表单元测试。
 * 覆盖：configFor 默认/已知/未知 target、懒建池与复用、endAll 遍历关闭。
 */
import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../src/pool.js';
import { ToolError } from '../src/errors.js';
import { makeDatasourceConfig, makeGlobalConfig } from './helpers.js';

function makeManager() {
  const sources = [
    makeDatasourceConfig({ target: 'app', maxRows: 1000 }),
    makeDatasourceConfig({ target: 'replica', maxRows: 5000, database: 'analytics' }),
  ];
  const global = makeGlobalConfig({ defaultTarget: 'app', poolSize: 3 });
  const manager = new ConnectionManager(
    sources,
    { poolSize: global.poolSize, poolIdleTimeoutMs: global.poolIdleTimeoutMs },
    global.defaultTarget,
  );
  return { manager, sources, global };
}

describe('ConnectionManager.configFor', () => {
  it('缺省 target 返回默认源配置', () => {
    const { manager, sources } = makeManager();
    expect(manager.configFor().target).toBe('app');
    expect(manager.configFor()).toEqual(sources[0]);
  });

  it('指定已知 target 返回对应源配置', () => {
    const { manager, sources } = makeManager();
    expect(manager.configFor('replica')).toEqual(sources[1]);
  });

  it('未知 target 抛 ToolError(PARAM)', () => {
    const { manager } = makeManager();
    expect(() => manager.configFor('ghost')).toThrow(ToolError);
    try {
      manager.configFor('ghost');
    } catch (e) {
      expect((e as ToolError).code).toBe('PARAM');
    }
  });
});

describe('ConnectionManager.resolve（懒建池与复用）', () => {
  it('首次 resolve 创建池，同一 target 复用同一实例', () => {
    const { manager } = makeManager();
    const a1 = manager.resolve('app');
    const a2 = manager.resolve('app');
    expect(a1).toBe(a2); // 复用
    const r = manager.resolve('replica');
    expect(r).not.toBe(a1); // 不同源不同池
  });

  it('缺省 target 解析到默认源', () => {
    const { manager } = makeManager();
    expect(manager.resolve().constructor.name).toBe('MysqlPool');
  });

  it('resolveWriter 与 resolve 为同一池（MysqlPool 同时实现两接口）', () => {
    const { manager } = makeManager();
    expect(manager.resolve('app')).toBe(manager.resolveWriter('app'));
  });
});

describe('ConnectionManager.endAll', () => {
  it('endAll 遍历关闭所有已建池', async () => {
    const { manager, sources, global } = makeManager();
    // 建立多个池
    manager.resolve('app');
    manager.resolve('replica');
    // 篡改池的 end 为 spy 以观测调用（替换内部实例）
    const ended: string[] = [];
    const poolA = manager.resolve('app') as unknown as { end(): Promise<void> };
    const poolR = manager.resolve('replica') as unknown as { end(): Promise<void> };
    poolA.end = async () => {
      ended.push('app');
    };
    poolR.end = async () => {
      ended.push('replica');
    };
    await manager.endAll();
    expect(ended.sort()).toEqual(['app', 'replica']);
    // 清空后再次 resolve 会重建
    const again = manager.resolve('app');
    expect(again).toBeTruthy();
    expect(sources.length).toBe(2);
    expect(global.poolSize).toBe(3);
  });
});
