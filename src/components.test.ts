import ts from "typescript";
import { describe, expect, it } from "vitest";
import { annotateSharedSchemaReferences, collectSchemaImports, deriveComponentName } from "./components";

const parse = (source: string) => ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const findOpenApiInitializer = (file: ts.SourceFile) => {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "openapi" && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }

  throw new Error("openapi initializer not found");
};

describe("deriveComponentName", () => {
  it("SCREAMING_SNAKE_CASE の _SCHEMA 接尾辞を取り除いて PascalCase にする", () => {
    expect(deriveComponentName("ERROR_RESPONSE_SCHEMA")).toBe("ErrorResponse");
    expect(deriveComponentName("EDIT_STATUS_SCHEMA")).toBe("EditStatus");
  });

  it("バージョン表記の数字トークンは区切りを残す", () => {
    expect(deriveComponentName("STATUS_V1_0_RESPONSE_SCHEMA")).toBe("StatusV1_0Response");
  });

  it("camelCase の Schema 接尾辞も取り除く", () => {
    expect(deriveComponentName("editStatusSchema")).toBe("EditStatus");
  });

  it("全大文字 1 トークンも PascalCase に揃える", () => {
    expect(deriveComponentName("ALBUM_SCHEMA")).toBe("Album");
  });
});

describe("collectSchemaImports", () => {
  it("指定モジュールからの *_SCHEMA named import だけを収集する", () => {
    const file = parse(`
      import { ERROR_RESPONSE_SCHEMA, getHeaders } from "@/lib/schema";
      import { EDIT_STATUS_SCHEMA } from "@natsuneko-laboratory/foreign-model";
      import { OTHER_SCHEMA } from "@/lib/other";
      import type { SOME_SCHEMA } from "@/lib/schema";
    `);

    const imports = collectSchemaImports(file, ["@/lib/schema", "@natsuneko-laboratory/foreign-model"]);

    expect(imports.get("ERROR_RESPONSE_SCHEMA")).toEqual({
      specifier: "@/lib/schema",
      exportedName: "ERROR_RESPONSE_SCHEMA",
    });
    expect(imports.get("EDIT_STATUS_SCHEMA")).toEqual({
      specifier: "@natsuneko-laboratory/foreign-model",
      exportedName: "EDIT_STATUS_SCHEMA",
    });
    // 命名規約に合わない export、対象外モジュール、type-only import は対象にしない
    expect(imports.has("getHeaders")).toBe(false);
    expect(imports.has("OTHER_SCHEMA")).toBe(false);
    expect(imports.has("SOME_SCHEMA")).toBe(false);
  });

  it("エイリアス付き import は元の export 名で記録する", () => {
    const file = parse(`import { ERROR_RESPONSE_SCHEMA as ERR } from "@/lib/schema";`);
    const imports = collectSchemaImports(file, ["@/lib/schema"]);

    expect(imports.get("ERR")).toEqual({ specifier: "@/lib/schema", exportedName: "ERROR_RESPONSE_SCHEMA" });
  });

  it("schemaModules が空なら何も収集しない", () => {
    const file = parse(`import { ERROR_RESPONSE_SCHEMA } from "@/lib/schema";`);
    expect(collectSchemaImports(file, []).size).toBe(0);
  });
});

describe("annotateSharedSchemaReferences", () => {
  const annotate = (source: string, schemaModules: string[]) => {
    const file = parse(source);
    const initializer = findOpenApiInitializer(file);
    const imports = collectSchemaImports(file, schemaModules);

    return annotateSharedSchemaReferences(initializer, file, imports);
  };

  it("共有スキーマの参照に .openapi(\"Name\") を注入する", () => {
    const { text, components } = annotate(
      `
      import { ERROR_RESPONSE_SCHEMA } from "@/lib/schema";
      import { z } from "zod";

      const openapi = {
        GET: {
          responses: {
            200: { description: "OK", schema: z.object({ id: z.string() }) },
            404: { description: "Not Found", schema: ERROR_RESPONSE_SCHEMA },
            500: { description: "Error", schema: ERROR_RESPONSE_SCHEMA },
          },
        },
      };
      `,
      ["@/lib/schema"],
    );

    expect(text).toContain(`schema: ERROR_RESPONSE_SCHEMA.openapi("ErrorResponse")`);
    expect(text.match(/\.openapi\("ErrorResponse"\)/g)).toHaveLength(2);
    expect(components).toEqual([{ name: "ErrorResponse", source: "@/lib/schema#ERROR_RESPONSE_SCHEMA" }]);
  });

  it("ネストされた z.object の中の参照にも注入する", () => {
    const { text } = annotate(
      `
      import { STATUS_V1_0_RESPONSE_SCHEMA } from "@/lib/schema";
      import { z } from "zod";

      const openapi = {
        GET: {
          responses: {
            200: { description: "OK", schema: z.object({ status: STATUS_V1_0_RESPONSE_SCHEMA }) },
          },
        },
      };
      `,
      ["@/lib/schema"],
    );

    expect(text).toContain(`status: STATUS_V1_0_RESPONSE_SCHEMA.openapi("StatusV1_0Response")`);
  });

  it("プロパティアクセスやメソッド呼び出しの対象には注入しない", () => {
    const { text, components } = annotate(
      `
      import { EDIT_STATUS_SCHEMA } from "@/lib/schema";

      const openapi = {
        PATCH: {
          request: { body: EDIT_STATUS_SCHEMA.partial() },
        },
      };
      `,
      ["@/lib/schema"],
    );

    expect(text).toContain("EDIT_STATUS_SCHEMA.partial()");
    expect(text).not.toContain(".openapi(");
    expect(components).toEqual([]);
  });

  it("request.params / request.query の直接の値には注入しない", () => {
    const { text, components } = annotate(
      `
      import { SUGGESTION_QUERY_SCHEMA, EDIT_STATUS_SCHEMA } from "@/lib/schema";

      const openapi = {
        GET: {
          request: {
            query: SUGGESTION_QUERY_SCHEMA,
            body: EDIT_STATUS_SCHEMA,
          },
        },
      };
      `,
      ["@/lib/schema"],
    );

    // query はパラメーターに分解されるため components にならない。body は対象
    expect(text).toContain("query: SUGGESTION_QUERY_SCHEMA,");
    expect(text).toContain(`body: EDIT_STATUS_SCHEMA.openapi("EditStatus")`);
    expect(components).toEqual([{ name: "EditStatus", source: "@/lib/schema#EDIT_STATUS_SCHEMA" }]);
  });

  it("同じコンポーネント名が異なる定義から導出されたらエラーにする", () => {
    expect(() =>
      annotate(
        `
        import { ERROR_RESPONSE_SCHEMA } from "@/lib/schema";
        import { ERROR_RESPONSE_SCHEMA as FOREIGN_ERROR_RESPONSE_SCHEMA } from "@natsuneko-laboratory/foreign-model";

        const openapi = {
          GET: {
            responses: {
              404: { description: "Not Found", schema: ERROR_RESPONSE_SCHEMA },
              500: { description: "Error", schema: FOREIGN_ERROR_RESPONSE_SCHEMA },
            },
          },
        };
        `,
        ["@/lib/schema", "@natsuneko-laboratory/foreign-model"],
      ),
    ).toThrow(/component name conflict/);
  });

  it("エイリアス import でも元の export 名からコンポーネント名を導出する", () => {
    const { text, components } = annotate(
      `
      import { ERROR_RESPONSE_SCHEMA as ERR } from "@/lib/schema";

      const openapi = {
        GET: {
          responses: {
            404: { description: "Not Found", schema: ERR },
          },
        },
      };
      `,
      ["@/lib/schema"],
    );

    expect(text).toContain(`schema: ERR.openapi("ErrorResponse")`);
    expect(components).toEqual([{ name: "ErrorResponse", source: "@/lib/schema#ERROR_RESPONSE_SCHEMA" }]);
  });
});
