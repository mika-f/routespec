import path from "node:path";

export const toPosixPath = (value: string) => value.split(path.sep).join("/");

export const toRoutePath = (routeFile: string, appDir: string) => {
  const relative = toPosixPath(path.relative(appDir, routeFile));
  const withoutRouteFile = relative.replace(/\/route\.(?:[cm]?[jt]sx?)$/, "");
  const segments = withoutRouteFile.split("/").filter((segment) => {
    if (!segment) {
      return false;
    }

    if (segment.startsWith("(") && segment.endsWith(")")) {
      return false;
    }

    return !segment.startsWith("@");
  });

  const openApiSegments = segments.map((segment) => {
    const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
    if (optionalCatchAll) {
      return `{${optionalCatchAll[1]}}`;
    }

    const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) {
      return `{${catchAll[1]}}`;
    }

    const dynamic = segment.match(/^\[(.+)\]$/);
    if (dynamic) {
      return `{${dynamic[1]}}`;
    }

    return segment;
  });

  return `/${openApiSegments.join("/")}`;
};

export const getPathParameterNames = (routePath: string) =>
  Array.from(routePath.matchAll(/\{([^}]+)\}/g)).map((match) => match[1]);
