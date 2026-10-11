import { helper, more, version } from "@acme/core";
import { helper as h2 } from "@acme/core/lib/util";
import * as core from "@acme/core";
import { format } from "@shared/format";
import { z } from "./z.js";
import React from "react";
import { readFileSync } from "node:fs";
export function main(): string {
  return format(String(helper() + more() + h2() + core.helper() + version + z)) + readFileSync("x") + React.version;
}
