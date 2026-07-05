import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { findRouteFiles } from "./files";
import { importOpenApiDocs } from "./extractor";
import { getPathParameterNames, toRoutePath } from "./path";
import type {
  GenerateOpenApiOptions,
  GenerateOpenApiResult,
  HttpMethod,
  OperationDoc,
  ResponseDoc,
} from "./types";

extendZodWithOpenApi(z);

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
] as const satisfies readonly HttpMethod[];

export const generateOpenApi = async (
  options: GenerateOpenApiOptions,
): Promise<GenerateOpenApiResult> => {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const appDir = path.resolve(cwd, options.appDir);
  const output = path.resolve(cwd, options.output);

  await assertDirectory(appDir);

  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });

  const routeFiles = await findRouteFiles(appDir);
  const undocumentedRoutes: string[] = [];
  // コンポーネント名 → 導出元（モジュール#export 名）。同じ名前が異なる定義から導出されたら
  // 別構造のスキーマが同じ $ref に混ざってしまうため、生成を失敗させる
  const componentSources = new Map<string, string>();
  let documentedRouteCount = 0;
  let skippedInternalCount = 0;

  for (const routeFile of routeFiles) {
    const { docs, components } = await importOpenApiDocs(routeFile, cwd, {
      schemaModules: options.schemaModules,
    });
    const routePath = toRoutePath(routeFile, appDir);

    for (const component of components) {
      const existing = componentSources.get(component.name);
      if (existing && existing !== component.source) {
        throw new Error(
          `OpenAPI component name conflict: "${component.name}" is derived from both ${existing} and ${component.source}. Rename one of the exports.`,
        );
      }

      componentSources.set(component.name, component.source);
    }
    if (process.env.ROUTESPEC_DEBUG) {
      console.error(
        `routespec: ${routePath} ${docs ? "documented" : "undocumented"} (${routeFile})`,
      );
    }

    if (!docs) {
      undocumentedRoutes.push(routePath);
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = docs[method];
      if (!operation) {
        continue;
      }

      if (operation.internal && !options.includeInternal) {
        skippedInternalCount += 1;
        continue;
      }

      documentedRouteCount += 1;
      registry.registerPath(toRegistryPath({ method, routePath, operation }));
    }
  }

  if (options.failOnUndocumented && undocumentedRoutes.length > 0) {
    throw new Error(`Found ${undocumentedRoutes.length} undocumented route handler(s).`);
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: options.title ?? "API",
      version: options.version ?? "0.1.0",
    },
    servers: options.serverUrl ? [{ url: options.serverUrl }] : undefined,
  }) as unknown as Record<string, unknown>;

  const serialized = `${JSON.stringify(document, null, 2)}\n`;

  if (options.check) {
    const current = await readFile(output, "utf8").catch(() => undefined);
    if (current !== serialized) {
      throw new Error(
        `${path.relative(cwd, output)} is out of date. Run routespec generate to update it.`,
      );
    }

    return {
      document,
      routeCount: routeFiles.length,
      documentedRouteCount,
      skippedInternalCount,
      componentCount: componentSources.size,
      undocumentedRoutes,
      written: false,
    };
  }

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serialized);

  if (!options.silent && undocumentedRoutes.length > 0) {
    console.warn(
      `routespec: ${undocumentedRoutes.length} route handler(s) do not export openapi metadata.`,
    );
  }

  return {
    document,
    routeCount: routeFiles.length,
    documentedRouteCount,
    skippedInternalCount,
    componentCount: componentSources.size,
    undocumentedRoutes,
    written: true,
  };
};

const toRegistryPath = ({
  method,
  routePath,
  operation,
}: {
  method: HttpMethod;
  routePath: string;
  operation: OperationDoc;
}) => ({
  method: method.toLowerCase() as Lowercase<HttpMethod>,
  path: routePath,
  summary: operation.summary,
  description: operation.description,
  tags: operation.tags,
  security: operation.security,
  request: toOpenApiRequest(routePath, operation),
  responses: toOpenApiResponses(operation.responses),
});

const toOpenApiRequest = (routePath: string, operation: OperationDoc) => {
  const request = operation.request;
  const pathParameterNames = getPathParameterNames(routePath);
  const params = mergePathParameters(pathParameterNames, request?.params);
  const body = request?.body
    ? {
        content: {
          [request.contentType ?? "application/json"]: {
            schema: request.body,
          },
        },
      }
    : undefined;

  return {
    params,
    query: request?.query,
    body,
  };
};

const mergePathParameters = (
  pathParameterNames: string[],
  params: NonNullable<OperationDoc["request"]>["params"] | undefined,
) => {
  const fallback = Object.fromEntries(pathParameterNames.map((name) => [name, z.string()]));

  if (!params) {
    return Object.keys(fallback).length > 0 ? z.object(fallback) : undefined;
  }

  const shape = params.shape;

  return z.object({
    ...fallback,
    ...shape,
  });
};

const toOpenApiResponses = (responses: Record<number, ResponseDoc>) =>
  Object.fromEntries(
    Object.entries(responses).map(([status, response]) => [
      status,
      {
        description: response.description,
        ...(response.schema
          ? {
              content: {
                [response.contentType ?? "application/json"]: {
                  schema: response.schema,
                },
              },
            }
          : {}),
      },
    ]),
  );

const assertDirectory = async (dir: string) => {
  try {
    await access(dir);
  } catch {
    throw new Error(`App directory does not exist: ${dir}`);
  }
};
