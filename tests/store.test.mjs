import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual store without introducing a test framework or DOM library.
const source = await readFile(new URL('../src/store.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace("from 'react'", `from '${import.meta.resolve('react')}'`);
const { itemStore, MAX_ITEMS } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('mixed retention, file metadata, notifications, and exact URL lifetime', () => {
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  URL.createObjectURL = file => { const url = create(file); created.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
  let notifications = 0;
  const unsubscribe = itemStore.subscribe(() => notifications++);
  try {
    itemStore.addText(' \n ');
    assert.equal(itemStore.getSnapshot().length, 0);
    assert.equal(notifications, 0);
    const text = '  text with whitespace\n' + 'long-value'.repeat(1000);
    itemStore.addText(text);
    assert.equal(itemStore.getSnapshot()[0].text, text);
    const oldSnapshot = itemStore.getSnapshot();
    const files = Array.from({ length: 7 }, (_, i) => new File([`contents-${i}`], `${i}.txt`, { type: 'text/plain' }));
    itemStore.addFiles(files);
    assert.equal(oldSnapshot.length, 1, 'prior snapshots remain unchanged');
    assert.equal(itemStore.getSnapshot().length, MAX_ITEMS);
    assert.deepEqual(itemStore.getSnapshot().map(item => item.name), ['6.txt', '5.txt', '4.txt', '3.txt', '2.txt']);
    assert.equal(revoked.length, 2, 'overflow files released immediately');
    const fileItem = itemStore.getSnapshot()[0];
    assert.equal(fileItem.file, files[6]);
    assert.equal(fileItem.mimeType, 'text/plain');
    assert.equal(fileItem.size, files[6].size);
    assert.equal(fileItem.type, 'file');
    itemStore.remove(fileItem.id);
    assert.ok(revoked.includes(fileItem.url));
    itemStore.addText('newest');
    itemStore.addText('newest again');
    assert.equal(itemStore.getSnapshot()[0].text, 'newest again');
    assert.equal(itemStore.getSnapshot().length, MAX_ITEMS);
    assert.equal(revoked.length, 4);
    const ids = itemStore.getSnapshot().map(item => item.id);
    assert.equal(new Set(ids).size, MAX_ITEMS);
    assert.equal(notifications, 5);
    const image = new File(['image fixture'], 'screenshot.png', { type: 'image/png' });
    itemStore.addFiles([image]);
    assert.equal(itemStore.getSnapshot()[0].mimeType, 'image/png');
    assert.equal(itemStore.getSnapshot()[0].name, 'screenshot.png');
    unsubscribe();
    const count = notifications;
    for (const item of [...itemStore.getSnapshot()]) itemStore.remove(item.id);
    assert.equal(notifications, count, 'unsubscribe removes listener');
    assert.equal(itemStore.getSnapshot().length, 0);
    assert.equal(revoked.length, created.length);
    assert.equal(new Set(revoked).size, revoked.length, 'each URL released exactly once');
  } finally {
    unsubscribe();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
});
