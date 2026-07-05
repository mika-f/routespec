import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importOpenApiDocs } from "./extractor";

let projectDir: string;

// os.tmpdir() 配下だと Node のモジュール解決が packages/routespec/node_modules まで
// 辿り着けず @asteasolutions/zod-to-openapi の解決に失敗するため、パッケージ配下に作成する
const TEST_TMP_ROOT = path.join(process.cwd(), ".tmp-test");

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  projectDir = await mkdtemp(path.join(TEST_TMP_ROOT, "extractor-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

// cacheDir は importOpenApiDocs 内部で `${projectDir}/src/.routespec` に固定されるため、
// フィクスチャの import 指定子はそこから解決できるパスで直接書く
const SHARED_SCHEMA_SPECIFIER = "../../shared-schema";

const writeSharedSchemaFixture = async () => {
  await writeFile(
    path.join(projectDir, "shared-schema.ts"),
    `
    import { z } from "zod";

    export const ERROR_RESPONSE_SCHEMA = z.object({ message: z.string() });
    `,
  );
};

describe("importOpenApiDocs", () => {
  it("route.ts 内の openapi 変数から RouteDocs を抽出する", async () => {
    const routeFile = path.join(projectDir, "route.ts");
    await writeFile(
      routeFile,
      `
      import { z } from "zod";

      export const openapi = {
        GET: {
          summary: "list things",
          tags: ["test"],
          responses: {
            200: { description: "OK", schema: z.object({ id: z.string() }) },
          },
        },
      };

      export const GET = () => {};
      `,
    );

    const result = await importOpenApiDocs(routeFile, projectDir);

    expect(result.docs?.GET?.summary).toBe("list things");
    expect(result.components).toEqual([]);
  });

  it("schemaModules に一致する参照へ .openapi() を注入し、components を報告する", async () => {
    await writeSharedSchemaFixture();
    const routeFile = path.join(projectDir, "route.ts");
    await writeFile(
      routeFile,
      `
      import { ERROR_RESPONSE_SCHEMA } from "${SHARED_SCHEMA_SPECIFIER}";
      import { z } from "zod";

      export const openapi = {
        GET: {
          summary: "get thing",
          tags: ["test"],
          responses: {
            200: { description: "OK", schema: z.object({ id: z.string() }) },
            404: { description: "Not Found", schema: ERROR_RESPONSE_SCHEMA },
          },
        },
      };

      export const GET = () => {};
      `,
    );

    const result = await importOpenApiDocs(routeFile, projectDir, {
      schemaModules: [SHARED_SCHEMA_SPECIFIER],
    });

    expect(result.components).toEqual([
      { name: "ErrorResponse", source: `${SHARED_SCHEMA_SPECIFIER}#ERROR_RESPONSE_SCHEMA` },
    ]);

    // 実行時に注入された .openapi() が実際に zod スキーマへ refId を登録していることまで確認する
    const notFoundSchema = result.docs?.GET?.responses[404]?.schema as {
      _def?: { openapi?: { _internal?: { refId?: string } } };
    };
    expect(notFoundSchema?._def?.openapi?._internal?.refId).toBe("ErrorResponse");
  });

  it("route.ts に openapi 変数がなければ、隣接する openapi.ts から抽出する", async () => {
    const routeDir = path.join(projectDir, "nested");
    await mkdir(routeDir, { recursive: true });

    await writeFile(
      path.join(routeDir, "openapi.ts"),
      `
      import { z } from "zod";

      export const openapi = {
        GET: {
          summary: "from adjacent file",
          tags: ["test"],
          responses: {
            200: { description: "OK", schema: z.object({ id: z.string() }) },
          },
        },
      };
      `,
    );
    const routeFile = path.join(routeDir, "route.ts");
    await writeFile(
      routeFile,
      `
      import type { RouteHandlers } from "./types";
      import { openapi } from "./openapi";

      export const GET: RouteHandlers<typeof openapi>["GET"] = () => {};
      `,
    );

    const result = await importOpenApiDocs(routeFile, projectDir);

    expect(result.docs?.GET?.summary).toBe("from adjacent file");
  });

  it("openapi 変数が見つからなければ undefined と空の components を返す", async () => {
    const routeFile = path.join(projectDir, "route.ts");
    await writeFile(
      routeFile,
      `
      export const GET = () => {};
      `,
    );

    const result = await importOpenApiDocs(routeFile, projectDir);

    expect(result.docs).toBeUndefined();
    expect(result.components).toEqual([]);
  });
});
