import { expect, it } from 'vitest';
import { readRoute, safeReturnHash } from '../../src/router.js';

it('accepts only supported local routes and never follows an external callback return location', () => {
  const id = 'd7fe96c6-1d7b-4e25-b994-904f9cd9f673';
  expect(readRoute(`#/tasks/${id}`)).toEqual({ page: 'task', id });
  expect(readRoute(`#/projects/${id}`)).toEqual({ page: 'project', id });
  expect(readRoute(`#/projects/${id}/preaudit`)).toEqual({ page: 'preaudit', id });
  expect(readRoute(`#/preaudits/${id}`)).toEqual({ page: 'preaudit-report', id });
  expect(readRoute('#/rule-packages')).toEqual({ page: 'rule-packages' });
  expect(readRoute(`#/rule-packages/${id}/versions/${id}`)).toEqual({ page: 'rule-package', packageId: id, versionId: id });
  expect(safeReturnHash(`#/rule-packages/${id}/versions/invalid`)).toBe('#/projects');
  for (const value of ['https://untrusted.invalid', '//untrusted.invalid', '#/tasks/../../admin', '#/projects/invalid', '#/tasks/' + id + '/extra', null]) {
    expect(safeReturnHash(value)).toBe('#/projects');
  }
});
