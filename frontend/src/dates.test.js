import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime } from './dates.js';

describe('date formatting', () => {
  it('shows DD/MM/YYYY in IST regardless of the device timezone', () => {
    // 18:30 UTC on 13 Oct is 00:00 IST on 14 Oct.
    expect(formatDate('2026-10-13T18:30:00.000Z')).toBe('14/10/2026');
    expect(formatDateTime('2026-10-13T18:30:00.000Z')).toBe('14/10/2026 00:00 IST');
  });

  it('reads the API\'s +05:30 timestamps', () => {
    expect(formatDateTime('2026-10-14T16:48:00.000+05:30')).toBe('14/10/2026 16:48 IST');
  });

  it('returns an empty string for missing or invalid values', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('not a date')).toBe('');
  });
});
