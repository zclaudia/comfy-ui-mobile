import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

test('workspace UI strings and interpolation parameters exist in all four supported languages', () => {
  const keys = new Set<string>(); const directory = new URL('../../src/components/agent/workspace/', import.meta.url);
  const files = [
    new URL('../../src/platform/recoveryExport.ts', import.meta.url),
    ...readdirSync(directory).filter(file => /\.tsx?$/.test(file)).map(file => new URL(file, directory)),
    ...['DraftWorkingCopy', 'DraftRecoveryImport', 'DraftCanvasLoader'].map(file => new URL(`../../src/infrastructure/storage/${file}.ts`, import.meta.url)),
  ];
  for (const file of files) {
    const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.pathname.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => { if (ts.isStringLiteral(node) && /[\u4e00-\u9fff]/.test(node.text)) keys.add(node.text); ts.forEachChild(node, visit); }; visit(source);
  }
  assert.ok(keys.size > 80);
  const placeholders = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]).sort();
  for (const language of ['zh', 'en', 'ja', 'ko']) {
    const strings = JSON.parse(readFileSync(new URL(`../../src/locale/${language}/common.json`, import.meta.url), 'utf8')).agentUI as Record<string, string>;
    for (const key of keys) {
      assert.ok(strings[key]?.trim(), `${language}: ${key}`);
      assert.deepEqual(placeholders(strings[key]), placeholders(key), `${language}: ${key}`);
      // Japanese legitimately shares words such as 保存 and 停止 with Chinese.
      if (language === 'en' || language === 'ko') assert.notEqual(strings[key], key, `${language}: untranslated ${key}`);
    }
  }
});
