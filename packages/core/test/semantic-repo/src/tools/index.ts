import type { Tool } from '../types';
import { echo } from './echo';
import { upper } from './upper';

export { echo } from './echo';
export * from './upper';
export const tools: Tool[] = [echo, upper];
