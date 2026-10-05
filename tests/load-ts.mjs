import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

const modules = new Map();
export async function moduleUrl(path) {
  path = resolve(path);
  if (modules.has(path)) return modules.get(path);
  let code = ts.transpileModule(await readFile(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const match of [...code.matchAll(/from ['"]([^'"]+)['"]/g)]) {
    const specifier = match[1];
    const url = specifier.startsWith('.')
      ? await moduleUrl(resolve(dirname(path), `${specifier}.ts`))
      : import.meta.resolve(specifier);
    code = code.replace(match[0], `from '${url}'`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${path}`).toString('base64')}`;
  modules.set(path, url);
  return url;
}
