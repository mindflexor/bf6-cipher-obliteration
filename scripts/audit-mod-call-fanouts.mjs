import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'src/squad-obliteration/runtime/mode-runtime.ts');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const findings = [];

function functionName(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(source);
  }
  return '<module>';
}

function fanoutKind(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isForStatement(current) || ts.isForOfStatement(current) ||
      ts.isForInStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current)
    ) return 'loop';
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText(source);
      if (callee.endsWith('.forEach')) return 'forEach';
      if (callee === 'scheduleCipherGlobalTask') return 'timer';
    }
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) break;
  }
  return undefined;
}

function visit(node) {
  if (
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(source) === 'mod'
  ) {
    const kind = fanoutKind(node);
    if (kind) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({
        function: functionName(node),
        kind,
        api: node.expression.name.text,
        line: position.line + 1,
      });
    }
  }
  ts.forEachChild(node, visit);
}

visit(source);
const grouped = new Map();
for (const finding of findings) {
  const key = `${finding.function}/${finding.kind}`;
  grouped.set(key, (grouped.get(key) ?? 0) + 1);
}

console.log(`[mod-call-audit] ${findings.length} direct mod.* call sites occur inside loops, fan-outs, or scheduled callbacks.`);
for (const [key, count] of [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${key}: ${count}`);
}
if (process.argv.includes('--verbose')) {
  for (const finding of findings) {
    console.log(`  ${finding.line}: ${finding.function}/${finding.kind} -> mod.${finding.api}`);
  }
}
console.log('[mod-call-audit] Runtime safety is enforced by explicit subsystem cursors and verified by test:modsim:budget; production calls are not wrapped.');
