import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateOpenApi } from "./openapi";

let cwd: string;
let appDir: string;

// os.tmpdir() 配下だと Node のモジュール解決が packages/routespec/node_modules まで
// 辿り着けず @asteasolutions/zod-to-openapi の解決に失敗するため、パッケージ配下に作成する
const TEST_TMP_ROOT = path.join(process.cwd(), ".tmp-test");

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  cwd = await mkdtemp(path.join(TEST_TMP_ROOT, "openapi-"));
  appDir = path.join(cwd, "app");
  await mkdir(appDir, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const writeSharedSchemaFixture = async (fileName: string, exportName: string) => {
  await writeFile(
    path.join(cwd, fileName),
    `
    import { z } from "zod";

    export const ${exportName} = z.object({ message: z.string() });
    `,
  );
};

const writeRouteFixture = async (routeDir: string, sharedSchemaSpecifier: string, exportName: string) => {
  const dir = path.join(appDir, routeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "route.ts"),
    `
    import { ${exportName} } from "${sharedSchemaSpecifier}";
    import { z } from "zod";

    export const openapi = {
      GET: {
        summary: "GET /${routeDir}",
        tags: ["test"],
        responses: {
          200: { description: "OK", schema: z.object({ id: z.string() }) },
          404: { description: "Not Found", schema: ${exportName} },
        },
      },
    };

    export const GET = () => {};
    `,
  );
};

describe("generateOpenApi", () => {
  it("同じ共有スキーマを参照する複数ルートを1つの component に集約する", async () => {
    await writeSharedSchemaFixture("shared-schema.ts", "ERROR_RESPONSE_SCHEMA");
    await writeRouteFixture("a", "../../shared-schema", "ERROR_RESPONSE_SCHEMA");
    await writeRouteFixture("b", "../../shared-schema", "ERROR_RESPONSE_SCHEMA");

    const result = await generateOpenApi({
      cwd,
      appDir: "app",
      output: "openapi.json",
      schemaModules: ["../../shared-schema"],
      silent: true,
    });

    expect(result.componentCount).toBe(1);

    const schemas = (result.document.components as { schemas: Record<string, unknown> }).schemas;
    expect(Object.keys(schemas)).toEqual(["ErrorResponse"]);

    const notFoundA = getResponseSchema(result.document, "/a", "404");
    const notFoundB = getResponseSchema(result.document, "/b", "404");
    expect(notFoundA).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    expect(notFoundB).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
  });

  it("異なる定義から同じコンポーネント名が導出された場合はエラーにする", async () => {
    await writeSharedSchemaFixture("shared-schema-a.ts", "ERROR_RESPONSE_SCHEMA");
    await writeSharedSchemaFixture("shared-schema-b.ts", "ERROR_RESPONSE_SCHEMA");
    await writeRouteFixture("a", "../../shared-schema-a", "ERROR_RESPONSE_SCHEMA");
    await writeRouteFixture("b", "../../shared-schema-b", "ERROR_RESPONSE_SCHEMA");

    await expect(
      generateOpenApi({
        cwd,
        appDir: "app",
        output: "openapi.json",
        schemaModules: ["../../shared-schema-a", "../../shared-schema-b"],
        silent: true,
      }),
    ).rejects.toThrow(/component name conflict/);
  });

  it("schemaModules を指定しない場合は従来どおりインライン展開する", async () => {
    await writeSharedSchemaFixture("shared-schema.ts", "ERROR_RESPONSE_SCHEMA");
    await writeRouteFixture("a", "../../shared-schema", "ERROR_RESPONSE_SCHEMA");

    const result = await generateOpenApi({
      cwd,
      appDir: "app",
      output: "openapi.json",
      silent: true,
    });

    expect(result.componentCount).toBe(0);
    const notFound = getResponseSchema(result.document, "/a", "404");
    expect(notFound).toEqual({ type: "object", properties: { message: { type: "string" } }, required: ["message"] });
  });
});

const getResponseSchema = (document: Record<string, unknown>, routePath: string, status: string) => {
  const paths = document.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>>;
  return paths[routePath]?.get?.responses[status]?.content["application/json"]?.schema;
};
