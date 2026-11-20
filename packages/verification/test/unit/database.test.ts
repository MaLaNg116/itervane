import { expect, it } from 'vitest';
import { assertDisposableDatabase } from '../../src/database.js';

it('refuses schema-writing probes against ordinary application databases', () => {
  expect(() => assertDisposableDatabase('postgresql://localhost/production')).toThrow();
  expect(() => assertDisposableDatabase('postgresql://localhost/itervane_test')).not.toThrow();
});
