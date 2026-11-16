import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { validateInventory } from '../../src/evaluation.js';

const load = async () => JSON.parse(await readFile('evaluation/cases.json', 'utf8'));
const fixture = (file: string) => readFile(`fixtures/standard-app/${file}`, 'utf8');

it('prepares unique cases and unambiguous edits without executing mutated code', async () => {
  const inventory = await validateInventory(await load(), fixture);
  expect(inventory.cases).toHaveLength(24);
  expect(inventory.cases.filter(c => c.split === 'holdout')).toHaveLength(6);
});

it('rejects an edit that has drifted away from the reference source', async () => {
  await expect(validateInventory(await load(), async () => 'different source')).rejects.toThrow('Stale or ambiguous');
});

it('rejects a malicious fixture path before reading any file', async () => {
  const inventory = await load();
  inventory.cases[1].input.edits[0].file = '../../.env';
  let read = false;
  await expect(validateInventory(inventory, async () => { read = true; return ''; })).rejects.toThrow();
  expect(read).toBe(false);
});
