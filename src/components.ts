import ts from "typescript";

export type SchemaImport = {
  specifier: string;
  exportedName: string;
};

export type SchemaComponentRef = {
  name: string;
  source: string;
};

// 共有スキーマとして扱う export 名の規約。この接尾辞を持つ named import だけを
// components 化の対象にすることで、スキーマ以外の値（定数や関数など）に誤って
// .openapi() を注入して実行時エラーになるのを防ぐ
const SCHEMA_NAME_PATTERN = /(_SCHEMA|Schema)$/;

// schemaModules で指定されたモジュールからの named import のうち、
// 共有スキーマの命名規約に合致するものを「ローカル名 → import 元」の対応表として収集する
export const collectSchemaImports = (file: ts.SourceFile, schemaModules: string[]): Map<string, SchemaImport> => {
  const imports = new Map<string, SchemaImport>();
  if (schemaModules.length === 0) {
    return imports;
  }

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    if (!isSchemaModule(specifier, schemaModules)) {
      continue;
    }

    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly) {
      continue;
    }

    const namedBindings = importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      // namespace import (import * as S from ...) はプロパティアクセス経由の参照になり
      // refId の伝播リスクの判定が難しいため対象外とする
      continue;
    }

    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }

      const exportedName = element.propertyName?.text ?? element.name.text;
      if (!SCHEMA_NAME_PATTERN.test(exportedName)) {
        continue;
      }

      imports.set(element.name.text, { specifier, exportedName });
    }
  }

  return imports;
};

const isSchemaModule = (specifier: string, schemaModules: string[]) =>
  schemaModules.some((module) => specifier === module || specifier.startsWith(`${module}/`));

// SCREAMING_SNAKE_CASE / camelCase の export 名から components/schemas のキー名を導出する。
// 例: ERROR_RESPONSE_SCHEMA -> ErrorResponse, STATUS_V1_0_RESPONSE_SCHEMA -> StatusV1_0Response
export const deriveComponentName = (exportedName: string) => {
  const base = exportedName.replace(SCHEMA_NAME_PATTERN, "") || exportedName;

  if (!base.includes("_")) {
    // 全大文字 1 トークン（ALBUM など）も他の SCREAMING_SNAKE_CASE 由来の名前と同じ PascalCase に揃える
    const normalized = /^[A-Z0-9]+$/.test(base) ? base.charAt(0) + base.slice(1).toLowerCase() : base;
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  return base
    .split("_")
    .filter((token) => token.length > 0)
    .map((token) => {
      // 数字のみのトークンはバージョン表記（V1_0 など）の一部なので、区切りを残して曖昧さを避ける
      if (/^\d+$/.test(token)) {
        return `_${token}`;
      }

      const lower = token.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
};

// openapi 初期化子の中で共有スキーマを参照している識別子を __routespecOpenapi(X, "Name") で
// 包んだテキストと、注入したコンポーネントの一覧を返す。ヘルパーはキャッシュファイル内で
// 定義され（extractor.ts 参照）、zod のプロトタイプ拡張に依存せず _def.openapi へ直接 refId を
// 書き込むため、共有スキーマ側の zod がキャッシュファイルと別モジュールインスタンスでも機能する。
// refId は文字列ベースで重複排除されるため、tsImport がルートごとに独立したモジュール名前空間を
// 作る制約があっても同じ定数は同じ components/schemas エントリーに収束する
export const annotateSharedSchemaReferences = (
  initializer: ts.Expression,
  file: ts.SourceFile,
  schemaImports: Map<string, SchemaImport>,
): { text: string; components: SchemaComponentRef[] } => {
  const initializerStart = initializer.getStart(file);
  const componentSources = new Map<string, string>();
  const insertions: Array<{ offset: number; text: string }> = [];

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && isSchemaValueReference(node)) {
      const schemaImport = schemaImports.get(node.text);
      if (schemaImport) {
        const componentName = deriveComponentName(schemaImport.exportedName);
        const source = `${schemaImport.specifier}#${schemaImport.exportedName}`;
        const existing = componentSources.get(componentName);
        if (existing && existing !== source) {
          throw new Error(
            `OpenAPI component name conflict: "${componentName}" is derived from both ${existing} and ${source}. Rename one of the exports.`,
          );
        }

        componentSources.set(componentName, source);
        insertions.push({
          offset: node.getStart(file) - initializerStart,
          text: "__routespecOpenapi(",
        });
        insertions.push({
          offset: node.getEnd() - initializerStart,
          text: `, ${JSON.stringify(componentName)})`,
        });
      }
    }

    node.forEachChild(visit);
  };

  visit(initializer);

  let text = initializer.getText(file);
  // 先に計算したオフセットがずれないよう、後ろの挿入位置から順に適用する
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    text = `${text.slice(0, insertion.offset)}${insertion.text}${text.slice(insertion.offset)}`;
  }

  return {
    text,
    components: [...componentSources.entries()].map(([name, source]) => ({ name, source })),
  };
};

// 識別子が「スキーマ値そのものの参照」である場合のみ .openapi() を注入する。
// X.partial() のようなプロパティアクセスの対象に注入すると、派生スキーマへ refId が
// 伝播して元のスキーマとは異なる構造が components に登録されるおそれがあるため対象外とする
const isSchemaValueReference = (node: ts.Identifier) => {
  const parent = node.parent;

  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }

  // request.params / request.query は OpenAPI ではパラメーターに分解され components/schemas には
  // 現れない（params は生成時に shape が展開されて refId 自体が失われる）ため、注入しない
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name) &&
    (parent.name.text === "params" || parent.name.text === "query")
  ) {
    return false;
  }

  if (ts.isPropertyAccessExpression(parent)) {
    return false;
  }

  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    return false;
  }

  if (ts.isCallExpression(parent) && parent.expression === node) {
    return false;
  }

  if (ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }

  return true;
};
