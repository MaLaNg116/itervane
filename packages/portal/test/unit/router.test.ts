import { expect, it } from 'vitest';
import { readRoute, safeReturnHash } from '../../src/router.js';

it('accepts only supported local routes and never follows an external callback return location', () => {
  const id = 'd7fe96c6-1d7b-4e25-b994-904f9cd9f673';
  expect(readRoute(`#/tasks/${id}`)).toEqual({ page: 'task', id });
  expect(readRoute(`#/projects/${id}`)).toEqual({ page: 'project', id });
  for (const value of ['https://untrusted.invalid', '//untrusted.invalid', '#/tasks/../../admin', '#/projects/invalid', '#/tasks/' + id + '/extra', null]) {
    expect(safeReturnHash(value)).toBe('#/projects');
  }
});
