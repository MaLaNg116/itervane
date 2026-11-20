import { expect, it } from 'vitest';
import { cloudArguments } from '../../src/cloud.js';

it('keeps host-key checking on and prevents SSH option injection', () => {
  expect(cloudArguments({ ITERVANE_VALIDATION_SSH: 'operator@example.invalid' })).toContain('StrictHostKeyChecking=yes');
  expect(() => cloudArguments({ ITERVANE_VALIDATION_SSH: '-oProxyCommand=bad' })).toThrow();
  expect(() => cloudArguments({ ITERVANE_VALIDATION_SSH: 'host; echo bad' })).toThrow();
  expect(cloudArguments({})).toBeUndefined();
});
