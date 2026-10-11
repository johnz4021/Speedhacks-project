// 😀😀 héllo
import { tools, echo } from './tools';
import { Registry } from './registry';
import { provider } from './providers';

export async function main(name: string) {
  const r = new Registry(tools);
  await r.runAll('x');
  await r.get(name)?.run('y');
  await echo.run('z');
  provider().chat('hey');
  const loose: any = {};
  loose.whatever();
}
