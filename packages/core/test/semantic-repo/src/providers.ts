import { shout } from './util';
import type { Provider } from './types';

export abstract class Base {
  abstract chat(text: string): string;
  hello() {
    return this.chat('hi');
  }
}

export class Loud extends Base implements Provider {
  chat(text: string) {
    return shout(text);
  }
}

export function provider(): Provider {
  return new Loud();
}
