import { readdir } from "node:fs/promises";
import path from "node:path";

const ROUTE_FILE_PATTERN = /^route\.(?:[cm]?[jt]sx?)$/;

export const findRouteFiles = async (appDir: string): Promise<string[]> => {
  const files: string[] = [];

  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
        const current = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await visit(current);
          return;
        }

        if (entry.isFile() && ROUTE_FILE_PATTERN.test(entry.name)) {
          files.push(current);
        }
      }),
    );
  };

  await visit(appDir);

  return files.sort((a, b) => a.localeCompare(b));
};
