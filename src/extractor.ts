import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import ts from "typescript";
import {
  annotateSharedSchemaReferences,
  collectSchemaImports,
  type SchemaComponentRef,
} from "./components";
import type { RouteDocs } from "./types";

type ExtractedModule = {
  openapi?: RouteDocs;
  default?: {
    openapi?: RouteDocs;
  };
  "module.exports"?: {
    openapi?: RouteDocs;
  };
};

type OpenApiSource = {
  filename: string;
  source: string;
};

export type ImportOpenApiDocsResult = {
  docs: RouteDocs | undefined;
  components: SchemaComponentRef[];
};

export const importOpenApiDocs = async (
  routeFile: string,
  projectDir: string,
  options: { schemaModules?: string[] } = {},
): Promise<ImportOpenApiDocsResult> => {
  const source = await findOpenApiSource(routeFile);
  if (!source) {
    return { docs: undefined, components: [] };
  }

  const cacheDir = path.join(projectDir, "src", ".routespec");
  const { moduleSource, components } = extractOpenApiModuleSource(source, {
    projectDir,
    cacheDir,
    schemaModules: options.schemaModules ?? [],
  });
  const cacheFile = path.join(cacheDir, `${hashPath(source.filename)}.ts`);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, moduleSource);

  try {
    const cacheFileUrl = pathToFileURL(cacheFile).toString();

    // tsx の tsImport() は呼び出しごとに独立したモジュール解決の名前空間を作るため、
    // ここで別途 tsImport("zod", ...) して extendZodWithOpenApi() を適用しても、
    // キャッシュファイル自身が import する zod とは別のモジュールインスタンスになり効果がない。
    // そのため zod の拡張はキャッシュファイル自身の中で行う（extractOpenApiModuleSource 参照）。
    const imported = (await tsImport(cacheFileUrl, cacheFileUrl)) as ExtractedModule;
    if (process.env.ROUTESPEC_DEBUG) {
      console.error(
        `routespec: imported ${cacheFile} exports [${Object.keys(imported).join(", ")}]`,
      );
    }

    return {
      docs: imported.openapi ?? imported.default?.openapi ?? imported["module.exports"]?.openapi,
      components,
    };
  } finally {
    await rm(cacheFile, { force: true });
  }
};

const findOpenApiSource = async (routeFile: string): Promise<OpenApiSource | undefined> => {
  const routeSource = await readFile(routeFile, "utf8");
  if (hasOpenApiExport(routeSource, routeFile)) {
    if (process.env.ROUTESPEC_DEBUG) {
      console.error(`routespec: found inline openapi export in ${routeFile}`);
    }
    return { filename: routeFile, source: routeSource };
  }

  const adjacentOpenApi = path.join(path.dirname(routeFile), "openapi.ts");

  try {
    const adjacentSource = await readFile(adjacentOpenApi, "utf8");
    if (hasOpenApiExport(adjacentSource, adjacentOpenApi)) {
      if (process.env.ROUTESPEC_DEBUG) {
        console.error(`routespec: found adjacent openapi export in ${adjacentOpenApi}`);
      }
      return { filename: adjacentOpenApi, source: adjacentSource };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const extractOpenApiModuleSource = (
  { filename, source }: OpenApiSource,
  context: { projectDir: string; cacheDir: string; schemaModules: string[] },
) => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const openApiDeclaration = findOpenApiDeclaration(file);

  if (!openApiDeclaration?.initializer) {
    throw new Error(`Could not find an exported openapi initializer in ${filename}`);
  }

  // 共有スキーマの参照に .openapi("Name") を注入し、生成時に components/$ref として扱えるようにする。
  // 注入はこのキャッシュファイル内でのみ行われるため、実際のルートハンドラーの動作には影響しない
  const schemaImports = collectSchemaImports(file, context.schemaModules);
  const { text: initializerText, components } = annotateSharedSchemaReferences(
    openApiDeclaration.initializer,
    file,
    schemaImports,
  );

  const usedIdentifiers = collectIdentifiers(openApiDeclaration.initializer);
  const imports = file.statements
    .filter(ts.isImportDeclaration)
    .filter((statement) => importDeclarationHasUsedRuntimeBinding(statement, usedIdentifiers))
    .map((statement) => rewriteImportDeclaration(statement, file, context));

  const moduleSource = [
    // zod の拡張は、これから import する zod と同一のモジュールインスタンスに対して行う必要があるため、
    // このキャッシュファイル自身の中で import & 拡張する（詳細は importOpenApiDocs のコメント参照）。
    // また ESM の評価順序では import されたモジュール本体が先に評価されるため、注入した .openapi() は
    // この拡張処理より必ず後（openapi 初期化子の評価時）に実行される
    `import { extendZodWithOpenApi as __routespecExtendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";`,
    `import { z as __routespecZod } from "zod";`,
    `__routespecExtendZodWithOpenApi(__routespecZod);`,
    ...imports,
    `export const openapi = ${initializerText};`,
    "",
  ].join("\n");

  return { moduleSource, components };
};

const rewriteImportDeclaration = (
  statement: ts.ImportDeclaration,
  file: ts.SourceFile,
  { projectDir, cacheDir }: { projectDir: string; cacheDir: string },
) => {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) {
    return statement.getText(file);
  }

  const specifier = statement.moduleSpecifier.text;
  if (!specifier.startsWith("@/")) {
    return statement.getText(file);
  }

  const absolute = path.join(projectDir, "src", specifier.slice(2));
  const relative = toModuleSpecifier(path.relative(cacheDir, absolute));

  return statement
    .getText(file)
    .replace(statement.moduleSpecifier.getText(file), JSON.stringify(relative));
};

const toModuleSpecifier = (value: string) => {
  const normalized = value.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
};

const hasOpenApiExport = (source: string, filename: string) => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declaration = findOpenApiDeclaration(file);
  if (process.env.ROUTESPEC_DEBUG) {
    console.error(
      `routespec: ${filename} openapi declaration ${declaration ? "found" : "missing"}`,
    );
  }

  return Boolean(declaration);
};

// openapi は export されている必要はない（プラン C では export const GET = defineRoute(openapi, ...) の
// ように、openapi 自体はファイル内のローカル変数のまま defineRoute から参照される）
const findOpenApiDeclaration = (file: ts.SourceFile) => {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "openapi") {
        return declaration;
      }
    }
  }

  return undefined;
};

const collectIdentifiers = (node: ts.Node) => {
  const identifiers = new Set<string>();

  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current)) {
      identifiers.add(current.text);
    }

    current.forEachChild(visit);
  };

  visit(node);

  return identifiers;
};

const importDeclarationHasUsedRuntimeBinding = (
  statement: ts.ImportDeclaration,
  usedIdentifiers: Set<string>,
) => {
  if (statement.importClause?.isTypeOnly) {
    return false;
  }

  const importClause = statement.importClause;
  if (!importClause) {
    return false;
  }

  if (importClause.name && usedIdentifiers.has(importClause.name.text)) {
    return true;
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return false;
  }

  if (ts.isNamespaceImport(namedBindings)) {
    return usedIdentifiers.has(namedBindings.name.text);
  }

  return namedBindings.elements.some((element) => usedIdentifiers.has(element.name.text));
};

const hashPath = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
};
