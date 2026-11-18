import { expect, it } from 'vitest';
import { en, zhCN, negotiateLocale, apiErrorSchema, translate, taskStates, taskEventTypes } from '../../src/index.js';

it('keeps both catalogs complete for every error, task state and event', () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  for (const code of apiErrorSchema.shape.error.shape.code.options) expect(translate('zh-CN', `error.${code}`)).toBeTruthy();
  for (const state of taskStates) expect(translate('en', `state.${state}`)).toBeTruthy();
  for (const event of taskEventTypes) expect(translate('zh-CN', event)).toBeTruthy();
});

it('negotiates supported languages by quality and falls back without changing machine codes', () => {
  expect(negotiateLocale('fr, zh-Hans;q=0.8, en;q=0.5')).toBe('zh-CN');
  expect(negotiateLocale('zh-CN;q=0, en-US;q=0.8')).toBe('en');
  expect(negotiateLocale('de, zh;q=invalid')).toBe('en');
  expect(negotiateLocale('zh-TW')).toBe('en');
  expect(negotiateLocale()).toBe('en');
});
