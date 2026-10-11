export type ToolContext = { company: string };
export type Tool = { name: string; tags: string[]; run(input: string, ctx: ToolContext): Promise<string> };
