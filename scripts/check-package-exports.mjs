import { access } from "node:fs/promises";

const files = [
  "packages/weftdb/src/shared/index.ts",
  "packages/weftdb/src/schema/index.ts",
  "packages/weftdb/src/server/index.ts",
  "packages/weftdb/src/client/index.ts",
  "packages/weftdb-react/src/index.ts",
  "packages/weftdb/src/codegen/index.ts",
  "packages/weftdb-cli/src/index.ts",
  "packages/weftdb/src/index.ts",
];

await Promise.all(files.map((file) => access(file)));
console.log(`checked ${files.length} package entry points`);
