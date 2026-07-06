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
import { resolveAliasPath } from "./tsconfig-paths";
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
  // 拡張子は元のルートファイルと同じ .ts にする（.mts で ESM を強制すると、"type": "module" を
  // 持たないプロジェクトでは CJS として評価される共有スキーマ側と zod のモジュールインスタンスが
  // 分裂し、extendZodWithOpenApi() の拡張が共有スキーマへ届かなくなる）
  const cacheFile = path.join(cacheDir, `${hashPath(source.filename)}.ts`);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, moduleSource);

  try {
    const cacheFileUrl = pathToFileURL(cacheFile).toString();

    // tsx の tsImport() は呼び出しごとに独立したモジュール解決の名前空間を作る。共有スキーマへの
    // refId 付与はこの名前空間の分裂に影響されないよう、キャッシュファイル内の自己完結ヘルパーで
    // 行う（extractOpenApiModuleSource 参照）
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
    if (!process.env.ROUTESPEC_KEEP_CACHE) {
      await rm(cacheFile, { force: true });
    }
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
    // 共有スキーマへの refId 付与は zod のプロトタイプ拡張（extendZodWithOpenApi）ではなく、
    // _def.openapi へ直接書き込む自己完結のヘルパーで行う。プロトタイプ拡張はキャッシュファイルと
    // 共有スキーマ側で zod のモジュールインスタンスが分裂する環境（tsx のローダー実装や Node の
    // バージョンに依存して発生する）では届かないが、この方式はインスタンスの同一性に依存しない。
    // 生成側（openapi.ts）も _def.openapi をプレーンなプロパティとして読むだけなので整合する
    `const __routespecOpenapi = (schema: any, refId: string) => {`,
    `  const def = schema._def;`,
    `  return new schema.constructor({`,
    `    ...def,`,
    `    openapi: { ...def.openapi, _internal: { ...def.openapi?._internal, refId } },`,
    `  });`,
    `};`,
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
  // tsconfig.json の paths マッピングを優先し、見つからない場合のみ
  // 「@/foo -> <projectDir>/src/foo」という既定の規約にフォールバックする
  const absolute =
    resolveAliasPath(specifier, projectDir) ??
    (specifier.startsWith("@/") ? path.join(projectDir, "src", specifier.slice(2)) : undefined);

  if (!absolute) {
    return statement.getText(file);
  }

  // 拡張子なしの相対指定子はキャッシュファイルが CJS として評価される環境の require() で
  // 解決できないことがあるため、実ファイルを特定して拡張子付きのパスを埋め込む
  const relative = toModuleSpecifier(path.relative(cacheDir, resolveModuleFilePath(absolute)));

  return statement
    .getText(file)
    .replace(statement.moduleSpecifier.getText(file), JSON.stringify(relative));
};

const MODULE_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const resolveModuleFilePath = (basePath: string) => {
  if (ts.sys.fileExists(basePath)) {
    return basePath;
  }

  for (const extension of MODULE_FILE_EXTENSIONS) {
    if (ts.sys.fileExists(`${basePath}${extension}`)) {
      return `${basePath}${extension}`;
    }
  }

  for (const extension of MODULE_FILE_EXTENSIONS) {
    const indexPath = path.join(basePath, `index${extension}`);
    if (ts.sys.fileExists(indexPath)) {
      return indexPath;
    }
  }

  return basePath;
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
