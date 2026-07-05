#!/usr/bin/env node
import { parseArgs } from "node:util";
import { generateOpenApi } from "./openapi";
import type { GenerateOpenApiOptions } from "./types";

type ParsedArgs = {
  command?: string;
  options: Record<string, string | boolean | string[]>;
};

const main = async () => {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (!parsed.command || parsed.options.help || parsed.options.h) {
    printHelp();
    return;
  }

  if (parsed.command !== "generate") {
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  const options = toGenerateOptions(parsed.options);
  if (process.env.ROUTESPEC_DEBUG) {
    console.error(JSON.stringify({ argv: process.argv, parsed, options }, null, 2));
  }

  const result = await generateOpenApi(options);

  if (!options.silent) {
    const mode = options.check ? "checked" : "generated";
    const componentSummary =
      result.componentCount > 0 ? ` (${result.componentCount} shared component(s))` : "";
    console.log(
      `routespec: ${mode} ${result.documentedRouteCount} operation(s) from ${result.routeCount} route handler(s)${componentSummary}.`,
    );
  }
};

const parseCliArgs = (args: string[]): ParsedArgs => {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      "app-dir": { type: "string" },
      out: { type: "string" },
      output: { type: "string" },
      title: { type: "string" },
      version: { type: "string" },
      server: { type: "string" },
      "server-url": { type: "string" },
      "schema-module": { type: "string", multiple: true },
      "include-internal": { type: "boolean" },
      check: { type: "boolean" },
      "fail-on-undocumented": { type: "boolean" },
      silent: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  return { command: positionals[0], options: values };
};

const toGenerateOptions = (
  options: Record<string, string | boolean | string[]>,
): GenerateOpenApiOptions => ({
  cwd: stringOption(options.cwd),
  appDir: stringOption(options["app-dir"]) ?? "./src/app",
  output: stringOption(options.out) ?? stringOption(options.output) ?? "./public/openapi.json",
  title: stringOption(options.title),
  version: stringOption(options.version),
  serverUrl: stringOption(options.server) ?? stringOption(options["server-url"]),
  schemaModules: stringArrayOption(options["schema-module"]),
  includeInternal: Boolean(options["include-internal"]),
  check: Boolean(options.check),
  failOnUndocumented: Boolean(options["fail-on-undocumented"]),
  silent: Boolean(options.silent),
});

const stringOption = (value: string | boolean | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

const stringArrayOption = (value: string | boolean | string[] | undefined) =>
  Array.isArray(value) ? value : undefined;

const printHelp = () => {
  console.log(`routespec

Usage:
  routespec generate [options]

Options:
  --cwd <path>                    Project directory. Defaults to the current working directory.
  --app-dir <path>                Next.js app directory. Defaults to ./src/app.
  --out, --output <path>          Output OpenAPI JSON path. Defaults to ./public/openapi.json.
  --title <name>                  OpenAPI info.title. Defaults to API.
  --version <version>             OpenAPI info.version. Defaults to 0.1.0.
  --server <url>                  OpenAPI server URL.
  --schema-module <specifier>     Module whose exported schemas (*_SCHEMA / *Schema) are emitted as
                                  components/schemas and referenced via $ref. Repeatable.
  --include-internal              Include operations marked internal: true.
  --check                         Fail if the output file is stale.
  --fail-on-undocumented          Fail when a route handler has no openapi export.
  --silent                        Suppress summary output.
`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
