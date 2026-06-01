import { describe, expect, it } from 'vitest';
import { collectUrlsFromText } from './assetTopup.js';

describe('collectUrlsFromText', () => {
  it('collects relative JS module dependencies against the captured bundle URL', () => {
    const urls = new Set<string>();

    collectUrlsFromText(
      'import{a as b}from"./chunk.mjs";const utils=()=>import(`./collection-utils.mjs`);export{x}from"../shared.mjs";',
      urls,
      'https://framerusercontent.com/sites/site-id/script_main.mjs',
    );

    expect(Array.from(urls).sort()).toEqual([
      'https://framerusercontent.com/sites/shared.mjs',
      'https://framerusercontent.com/sites/site-id/chunk.mjs',
      'https://framerusercontent.com/sites/site-id/collection-utils.mjs',
    ]);
  });

  it('still collects absolute Framer asset URLs embedded in text', () => {
    const urls = new Set<string>();

    collectUrlsFromText(
      'const image = "https://framerusercontent.com/images/example.png?width=1200&height=800";',
      urls,
    );

    expect(urls).toEqual(new Set(['https://framerusercontent.com/images/example.png?width=1200&height=800']));
  });
});
