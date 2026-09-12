import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const roots = ["apps/server/tests", "apps/web/tests", "packages/protocol/tests", "tests/browser"];
const testFilePattern = /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/;

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testFiles(path) : testFilePattern.test(entry.name) ? [path] : [];
  });
}

function isTestCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test";
}

function isSuiteCall(node) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "test"
    && node.expression.name.text === "describe"
    && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text.trim().length > 0;
}

function belongsToSuite(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && current.parent
      && isSuiteCall(current.parent)
      && current.parent.arguments.includes(current)) return true;
  }
  return false;
}

const failures = [];
let testCount = 0;
for (const path of roots.flatMap(testFiles)) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    extname(path) === ".tsx" ? ts.ScriptKind.TSX
      : extname(path) === ".ts" ? ts.ScriptKind.TS
        : ts.ScriptKind.JS,
  );
  function visit(node) {
    if (isTestCall(node)) {
      testCount += 1;
      if (!belongsToSuite(node)) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(`${relative(process.cwd(), path)}:${line + 1}:${character + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (failures.length) {
  console.error("Every test must be nested in a named test.describe(...) suite:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Test suite structure valid: ${testCount} tests are nested in named suites.`);
}
