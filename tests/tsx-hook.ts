// Node strips TypeScript types natively but does not understand JSX, and the demo page is
// written the way an application would write it. TypeScript's own transpiler turns .tsx into
// plain modules on the way in — no build step, no second copy of the page to test against.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        // The demo imports `./store.ts` by its real extension, which the transpiler must keep.
        rewriteRelativeImportExtensions: false,
      },
    });
    return { format: "module", shortCircuit: true, source: outputText };
  },
});
