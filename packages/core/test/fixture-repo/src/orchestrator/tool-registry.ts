import { tools } from "../tools/index";
export const registry = new Map(tools.map((t) => [t.name, t]));
