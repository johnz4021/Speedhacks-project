import type { Tool } from '../types';
import { shout } from '../util';

export const echo: Tool = {
  name: 'echo',
  async run(input) {
    return shout(input);
  },
};
