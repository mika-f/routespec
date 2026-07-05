import type { NextResponse } from "next/server";
import type { z, ZodObject, ZodRawShape, ZodType } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

// OPTIONS は CORS プリフライト用で OpenAPI Spec の生成対象外だが、defineRoute での型付けは許可する
export type RouteMethod = HttpMethod | "OPTIONS";

export type ResponseDoc = {
  description: string;
  schema?: ZodType;
  contentType?: string;
};

export type OperationDoc = {
  summary: string;
  description?: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  internal?: boolean;
  request?: {
    params?: ZodObject<ZodRawShape>;
    query?: ZodObject<ZodRawShape>;
    body?: ZodType;
    contentType?: string;
  };
  responses: Record<number, ResponseDoc>;
};

export type RouteDocs = Partial<Record<HttpMethod, OperationDoc>>;

type MaybePromise<T> = T | Promise<T>;

type ResponseUnion<R extends Record<number, ResponseDoc>> = {
  [K in keyof R]: R[K] extends { schema: infer S extends ZodType }
    ? NextResponse<z.infer<S>>
    : NextResponse<null>;
}[keyof R];

type ParamsOf<Op extends OperationDoc> = Op["request"] extends {
  params: infer P extends ZodObject<ZodRawShape>;
}
  ? { params: Promise<z.infer<P>> }
  : { params: Promise<any> };

export type RouteHandlerFn<Op extends OperationDoc> = (
  req: Request,
  ctx: ParamsOf<Op>,
) => MaybePromise<ResponseUnion<Op["responses"]>>;

export type RouteHandlers<Docs extends RouteDocs> = {
  [M in keyof Docs]: Docs[M] extends OperationDoc ? RouteHandlerFn<Docs[M]> : never;
};

// openapi に定義がないメソッド（OPTIONS など）向けの緩いハンドラー型
export type GenericRouteHandlerFn = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => MaybePromise<NextResponse<unknown>>;

// defineRoute(docs, method, handler) が返すハンドラー（Next.js が実際に呼び出す形。req, ctx の 2 引数のみ）の型を導出する。
// OPTIONS は openapi への定義が不要な設計（5.2）のため GenericRouteHandlerFn にフォールバックするが、
// それ以外のメソッドが docs に定義されていない場合は never にし、定義漏れをコンパイルエラーとして検知する
export type RouteHandlerFnFor<Docs extends RouteDocs, M extends RouteMethod> = M extends "OPTIONS"
  ? GenericRouteHandlerFn
  : M extends keyof Docs
    ? Docs[M] extends OperationDoc
      ? RouteHandlerFn<Docs[M]>
      : never
    : never;

// defineRoute(docs, method, ...) の meta（第三引数）に渡る値 = docs[method] の型。
// OPTIONS は undefined、それ以外の未定義メソッドは never（RouteHandlerFnFor と同じ理由）
export type MetaFor<Docs extends RouteDocs, M extends RouteMethod> = M extends "OPTIONS"
  ? undefined
  : M extends keyof Docs
    ? Docs[M] extends OperationDoc
      ? Docs[M]
      : never
    : never;

// defineRoute に渡す handler 自体の型。req, ctx に加えて、docs[method] を解決した meta を第三引数として受け取れる。
// Array.prototype.map の callback などと同様、meta を使わない場合は宣言自体を省略してよい
export type DefineRouteHandlerFn<Op extends OperationDoc> = (
  req: any,
  ctx: ParamsOf<Op>,
  meta: Op,
) => MaybePromise<ResponseUnion<Op["responses"]>>;

export type GenericDefineRouteHandlerFn = (
  req: any,
  ctx: { params: Promise<Record<string, string>> },
  meta: undefined,
) => MaybePromise<NextResponse<unknown>>;

// defineRoute(docs, method, handler) の handler に期待する型。RouteHandlerFnFor と同じ規則で
// OPTIONS 以外の未定義メソッドは never にし、定義漏れをコンパイルエラーとして検知する
export type DefineRouteHandlerFnFor<
  Docs extends RouteDocs,
  M extends RouteMethod,
> = M extends "OPTIONS"
  ? GenericDefineRouteHandlerFn
  : M extends keyof Docs
    ? Docs[M] extends OperationDoc
      ? DefineRouteHandlerFn<Docs[M]>
      : never
    : never;

export type GenerateOpenApiOptions = {
  cwd?: string;
  appDir: string;
  output: string;
  title?: string;
  version?: string;
  serverUrl?: string;
  includeInternal?: boolean;
  check?: boolean;
  failOnUndocumented?: boolean;
  silent?: boolean;
  // ここで指定したモジュールから import された共有スキーマ（*_SCHEMA / *Schema）は、
  // インライン展開ではなく components/schemas への登録 + $ref 参照として生成される
  schemaModules?: string[];
};

export type GenerateOpenApiResult = {
  document: Record<string, unknown>;
  routeCount: number;
  documentedRouteCount: number;
  skippedInternalCount: number;
  componentCount: number;
  undocumentedRoutes: string[];
  written: boolean;
};
