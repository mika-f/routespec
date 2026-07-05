# routespec

`routespec` generates an OpenAPI 3.1 document from annotated Next.js Route Handlers.

## Install

```bash
npm install @natsuneko-laboratory/routespec
```

`next` and `zod` are peer dependencies and must already be present in your project.
Installing the package also makes the `routespec` CLI available (e.g. via `npx routespec`
or a `package.json` script).

`openapi` can be defined in three equivalent ways; pick whichever fits the route best.

## Plan A: inline in `route.ts`

```ts
// @route.ts
import { z } from "zod";
import type { RouteDocs, RouteHandlers } from "@natsuneko-laboratory/routespec";

export const openapi = {
  GET: {
    summary: "Get current user",
    tags: ["egeria"],
    responses: {
      200: {
        description: "Current user",
        schema: z.object({ id: z.string() }),
      },
    },
  },
} satisfies RouteDocs;

export const GET: RouteHandlers<typeof openapi>["GET"] = async () => {
  // ...
};
```

## Plan B: adjacent `openapi.ts`

```ts
// @openapi.ts
import { z } from "zod";
import type { RouteDocs } from "@natsuneko-laboratory/routespec";

export const openapi = {
  GET: {
    summary: "Get current user",
    tags: ["egeria"],
    responses: {
      200: {
        description: "Current user",
        schema: z.object({ id: z.string() }),
      },
    },
  },
} satisfies RouteDocs;

// @route.ts
import type { RouteHandlers } from "@natsuneko-laboratory/routespec";
import { openapi } from "./openapi";

export const GET: RouteHandlers<typeof openapi>["GET"] = async () => {
  // ...
};
```

## Plan C: `defineRoute`

`defineRoute(docs, method, handler)` infers the handler's type from `docs` and `method`
directly, so there is no need to write `RouteHandlers<typeof openapi>["GET"]` separately.
`openapi` does not need to be exported — it can stay a local `const` in `route.ts`.

```ts
// @route.ts
import { z } from "zod";
import { defineRoute } from "@natsuneko-laboratory/routespec";
import type { RouteDocs } from "@natsuneko-laboratory/routespec";

const openapi = {
  GET: {
    summary: "Get current user",
    tags: ["egeria"],
    responses: {
      200: {
        description: "Current user",
        schema: z.object({ id: z.string() }),
      },
    },
  },
} satisfies RouteDocs;

export const GET = defineRoute(openapi, "GET", async (req, ctx) => {
  // ...
});

// OPTIONS (CORS preflight) is excluded from openapi/generation, but can still be
// defined through defineRoute for consistent typing.
export const OPTIONS = defineRoute(openapi, "OPTIONS", async (req) => {
  return new Response(null, { status: 200 });
});
```

The handler also receives a third, optional `meta` argument — the resolved value of
`docs[method]` (i.e. `openapi.GET` itself). It is never passed to Next.js; it only exists
for the handler to use (e.g. to run `meta.request.body.safeParseAsync(...)` without closing
over the outer `openapi` variable). Like `Array.prototype.map`'s callback, you can omit it
(or `ctx`) entirely if you don't need it. For methods with no matching entry in `docs`
(e.g. `OPTIONS`), `meta` is typed as `undefined`.

`OPTIONS` is the only method allowed to have no entry in `docs` (it's excluded from
generation by design). Calling `defineRoute(openapi, "POST", ...)` when `openapi` has no
`POST` entry is a compile error (`handler` resolves to `never`) — this catches routes that
forgot to document a method.

```ts
export const GET = defineRoute(openapi, "GET", async (req, ctx, meta) => {
  console.log(meta.summary); // "Get current user"
  // ...
});
```

```bash
routespec generate --app-dir ./src/app --out ./public/openapi.json
```

## Shared schema components (`--schema-module`)

By default every request/response schema is inlined into the generated document. Passing
`--schema-module <specifier>` (repeatable) tells the generator to emit schemas imported
from those modules as `components/schemas` entries and reference them via `$ref` instead:

```bash
routespec generate \
  --schema-module @natsuneko-laboratory/foreign-model \
  --schema-module @/lib/schema
```

Rules:

- Only **named imports** whose exported name ends with `_SCHEMA` or `Schema` are eligible.
  This convention prevents `.openapi()` from being injected into non-schema values.
- The component name is derived from the exported name:
  `ERROR_RESPONSE_SCHEMA` → `ErrorResponse`, `STATUS_V1_0_RESPONSE_SCHEMA` → `StatusV1_0Response`.
- Only direct references are rewritten. Derived schemas (e.g. `FOO_SCHEMA.partial()`) and
  schemas used as `request.params` / `request.query` (which become OpenAPI parameters, not
  schemas) are left inlined.
- If the same component name would be derived from two different declarations, generation
  fails with a conflict error — rename one of the exports.
