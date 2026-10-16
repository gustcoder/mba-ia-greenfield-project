// Jest runs in CommonJS, but some Nest packages ship ESM only
// (e.g. @nestjs/bullmq >= 12, "type": "module"). Node itself loads them via
// require(esm); Jest's runtime cannot, so these packages are transpiled here.
// Listed in `transformIgnorePatterns` of package.json and test/jest-e2e.json.
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        allowJs: true,
      },
    });
    return { code: outputText };
  },
};
