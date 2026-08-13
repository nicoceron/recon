import { describe, expect, it } from 'vitest';
import { isGpuRiskyEmbedUrl } from './assetInterceptor.js';

describe('isGpuRiskyEmbedUrl', () => {
  it('matches GPU-heavy video embed hosts without matching lookalikes', () => {
    expect(isGpuRiskyEmbedUrl('https://www.youtube.com/embed/no_elVGGgW8')).toBe(true);
    expect(isGpuRiskyEmbedUrl('https://player.vimeo.com/video/123')).toBe(true);
    expect(isGpuRiskyEmbedUrl('https://youtube.com.evil.test/embed/id')).toBe(false);
    expect(isGpuRiskyEmbedUrl('https://pudding.cool/story')).toBe(false);
  });
});
