import type { ToolContext } from "../shared/types";
export function validate(input: unknown): input is ToolContext { return typeof input === "string"; }
