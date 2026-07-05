import { defineConfig } from "tsup";

const external = ["next", "zod", "typescript", "tsx", "tsx/esm/api", "@asteasolutions/zod-to-openapi"];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      helpers: "src/helpers.ts",
      types: "src/types.ts",
    },
    format: ["esm"],
    target: "node20",
    dts: true,
    sourcemap: true,
    clean: true,
    external,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    dts: false,
    sourcemap: true,
    external,
  },
]);
