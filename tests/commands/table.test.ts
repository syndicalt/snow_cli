import { describe, it, expect } from 'vitest';
import { flattenValue } from '../../src/commands/table.js';

describe('flattenValue', () => {
  it('returns an empty string for null', () => {
    expect(flattenValue(null)).toBe('');
  });

  it('returns an empty string for undefined', () => {
    expect(flattenValue(undefined)).toBe('');
  });

  it('returns the display_value when present and non-empty', () => {
    expect(flattenValue({ value: 'INC0001', display_value: 'INC0001 - Login issue' })).toBe(
      'INC0001 - Login issue'
    );
  });

  it('falls back to value when display_value is empty string', () => {
    expect(flattenValue({ value: 'some_raw_value', display_value: '' })).toBe('some_raw_value');
  });

  it('returns value when no display_value key exists', () => {
    expect(flattenValue({ value: 'just-a-value' })).toBe('just-a-value');
  });

  it('JSON-stringifies a plain object with no value or display_value', () => {
    const obj = { nested: true };
    expect(flattenValue(obj)).toBe(JSON.stringify(obj));
  });

  it('converts numbers to strings', () => {
    expect(flattenValue(42)).toBe('42');
  });

  it('converts booleans to strings', () => {
    expect(flattenValue(true)).toBe('true');
    expect(flattenValue(false)).toBe('false');
  });

  it('returns string values as-is', () => {
    expect(flattenValue('hello')).toBe('hello');
  });
});
