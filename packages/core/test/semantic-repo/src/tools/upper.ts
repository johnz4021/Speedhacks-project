import type { Tool } from '../types';

export const upper = {
  name: 'upper',
  async run(input: string) {
    return input.toUpperCase();
  },
} satisfies Tool;
