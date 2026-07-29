#!/usr/bin/env node
import { run } from "./index.js";

const color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const result = run(process.argv.slice(2), { color });

process.stdout.write(result.stdout);
process.exitCode = result.exitCode;
