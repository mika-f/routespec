import path from "node:path";
import ts from "typescript";

type TsConfigPaths = {
  baseUrl: string;
  paths: Record<string, string[]>;
};

// プロジェクトごとに tsconfig.json の解析結果をキャッシュする（generate 1 回の実行で
// ルートファイルの数だけ呼び出されるため、ファイルごとに読み直さないようにする）
const cache = new Map<string, TsConfigPaths | undefined>();

const loadTsConfigPaths = (projectDir: string): TsConfigPaths | undefined => {
  if (cache.has(projectDir)) {
    return cache.get(projectDir);
  }

  const result = readTsConfigPaths(projectDir);
  cache.set(projectDir, result);
  return result;
};

const readTsConfigPaths = (projectDir: string): TsConfigPaths | undefined => {
  const configPath = ts.findConfigFile(projectDir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return undefined;
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error || !configFile.config) {
    return undefined;
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );

  const paths = parsed.options.paths;
  if (!paths) {
    return undefined;
  }

  return { baseUrl: parsed.options.baseUrl ?? path.dirname(configPath), paths };
};

// tsconfig の paths マッピングに従って specifier（例: "@/lib/schema"）を絶対パスへ解決する。
// マッチするエントリーが見つからない場合は undefined を返し、呼び出し側での既定の規約に委ねる
export const resolveAliasPath = (specifier: string, projectDir: string): string | undefined => {
  const config = loadTsConfigPaths(projectDir);
  if (!config) {
    return undefined;
  }

  for (const [pattern, targets] of Object.entries(config.paths)) {
    const wildcard = matchPathPattern(pattern, specifier);
    if (wildcard === undefined) {
      continue;
    }

    const target = targets[0];
    if (target === undefined) {
      continue;
    }

    return path.resolve(config.baseUrl, target.replace("*", wildcard));
  }

  return undefined;
};

// "@/*" のようなワイルドカードパターンに specifier がマッチするか判定し、マッチした部分（* に対応する箇所）を返す
const matchPathPattern = (pattern: string, specifier: string): string | undefined => {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) {
    return pattern === specifier ? "" : undefined;
  }

  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return undefined;
  }

  return specifier.slice(prefix.length, specifier.length - suffix.length);
};
