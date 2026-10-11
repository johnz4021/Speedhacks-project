// Ünïcödé 😀 comment so offsets differ between UTF-8 and UTF-16.
export interface Tool {
  name: string;
  run(input: string): Promise<string>;
}

export type Provider = { chat(text: string): string };
