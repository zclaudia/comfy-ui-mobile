import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import i18next from 'i18next';
const languages=['zh','en','ja','ko'];
const dictionaries=Object.fromEntries(languages.map(l=>[l,JSON.parse(readFileSync(new URL(`../../src/locale/${l}/common.json`,import.meta.url),'utf8'))]));
test('assistant translations cover each supported locale and interpolate counters', async () => {
 const expected=Object.keys(dictionaries.zh.agentUI).sort();
 for(const lang of languages){
   assert.deepEqual(Object.keys(dictionaries[lang].agentUI).sort(),expected);
   const i18n=i18next.createInstance();await i18n.init({lng:lang,resources:{[lang]:{translation:dictionaries[lang]}},fallbackLng:false});
   assert(!i18n.t('agentUI.工作流 v{{version}}',{version:2}).includes('{{'));
   assert(!i18n.t('agentUI.版本历史（{{count}}）',{count:2}).includes('{{'));
   assert.deepEqual(Object.keys(dictionaries[lang].tabs).sort(),['chats','gallery','workflows']);
 }
});
test('all literal assistant UI translation keys exist',()=>{
 const root=new URL('../../src/components/agent/',import.meta.url);
 for(const folder of [root,new URL('transcript/',root)]) for(const name of readdirSync(folder).filter(n=>n.endsWith('.tsx'))){
   const source=readFileSync(new URL(name,folder),'utf8');
   for(const match of source.matchAll(/\bat\('([^']+)'/g)) assert(match[1] in dictionaries.zh.agentUI,`${name}: ${match[1]}`);
   for(const match of source.matchAll(/\b(?:text|action|title)="([^"]+)"/g)) if(/[\u4e00-\u9fff]/.test(match[1])) assert(match[1] in dictionaries.zh.agentUI,`${name}: ${match[1]}`);
 }
});
