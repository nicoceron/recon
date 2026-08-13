import { describe, expect, it } from 'vitest';
import { buildResponsiveViewportMatrix, DEFAULT_RECONSTRUCTION_VIEWPORTS } from './capture.js';

describe('buildResponsiveViewportMatrix', () => {
  it('keeps required widths and probes immediately around discovered breakpoints', () => {
    const matrix = buildResponsiveViewportMatrix(DEFAULT_RECONSTRUCTION_VIEWPORTS, [768, 1200]);
    const widths = matrix.map((viewport) => viewport.width);

    expect(widths).toContain(390);
    expect(widths).toContain(810);
    expect(widths).toContain(1440);
    expect(widths).toEqual(expect.arrayContaining([767, 768, 769, 1199, 1200, 1201]));
    expect(matrix.find((viewport) => viewport.width === 768)?.source).toBe('breakpoint');
    expect(matrix.find((viewport) => viewport.width === 1440)?.core).toBe(true);
  });

  it('does not add the broad default coverage matrix when custom widths are supplied', () => {
    const matrix = buildResponsiveViewportMatrix(
      [{ name: 'custom', width: 1111, height: 777, source: 'user', core: true }],
      [900],
      true,
    );

    expect(matrix.map((viewport) => viewport.width)).toEqual([899, 900, 901, 1111]);
    expect(matrix.some((viewport) => viewport.width === 1920)).toBe(false);
  });

  it('deduplicates breakpoints that overlap required widths', () => {
    const matrix = buildResponsiveViewportMatrix(DEFAULT_RECONSTRUCTION_VIEWPORTS, [390]);
    const at390 = matrix.filter((viewport) => viewport.width === 390);

    expect(at390).toHaveLength(1);
    expect(at390[0]?.name).toBe('mobile');
    expect(at390[0]?.core).toBe(true);
  });
});
