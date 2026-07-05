import type { DefineRouteHandlerFnFor, MetaFor, OperationDoc, RouteDocs, RouteHandlerFnFor, RouteMethod } from "./types";

/**
 * openapi と HTTP メソッド名からハンドラーの型を導出する。
 * `export const GET: RouteHandlers<typeof openapi>["GET"] = ...` のような
 * 個別の型注釈を書かずに、`export const GET = defineRoute(openapi, "GET", ...)`
 * の形式でルートハンドラーを定義できる。
 *
 * handler は req, ctx に加えて、docs[method] を解決した meta を第三引数として受け取れる
 * （Array.prototype.map の callback などと同様、使わない場合は宣言自体を省略してよい）。
 * meta は Next.js には渡らず、defineRoute が返すハンドラーは req, ctx の 2 引数のみを受け取る。
 */
export const defineRoute = <Docs extends RouteDocs, M extends RouteMethod>(
  docs: Docs,
  method: M,
  handler: DefineRouteHandlerFnFor<Docs, M>,
): RouteHandlerFnFor<Docs, M> => {
  const meta = (docs as Partial<Record<string, OperationDoc>>)[method] as MetaFor<Docs, M>;
  const wrapped = (req: Request, ctx: unknown) =>
    (handler as (req: Request, ctx: unknown, meta: MetaFor<Docs, M>) => unknown)(req, ctx, meta);

  return wrapped as RouteHandlerFnFor<Docs, M>;
};
