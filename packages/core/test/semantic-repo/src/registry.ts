import type { Tool } from './types';

export class Registry {
  private byName = new Map<string, Tool>();

  constructor(list: Tool[]) {
    for (const t of list) this.byName.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  async runAll(input: string): Promise<string[]> {
    const out: string[] = [];
    for (const t of this.byName.values()) out.push(await t.run(input));
    return out;
  }
}
