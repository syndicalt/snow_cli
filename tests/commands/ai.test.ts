import { describe, it, expect } from 'vitest';
import {
  normaliseBuildResponse,
  parseBuildResponse,
  slugify,
  diffBuilds,
} from '../../src/commands/ai.js';
import type { SNBuildResponse, SNArtifact } from '../../src/types/index.js';

// ─── slugify ──────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slugify('  My Build  ')).toBe('my-build');
  });

  it('collapses multiple non-alphanumeric characters into a single hyphen', () => {
    expect(slugify('Incident & Priority Utils!')).toBe('incident-priority-utils');
  });

  it('handles already-slug strings', () => {
    expect(slugify('my-utils')).toBe('my-utils');
  });

  it('handles numbers', () => {
    expect(slugify('Version 2.0 Release')).toBe('version-2-0-release');
  });
});

// ─── normaliseBuildResponse ───────────────────────────────────────────────────

describe('normaliseBuildResponse', () => {
  it('parses a well-formed response with nested fields', () => {
    const input = {
      name: 'My Build',
      description: 'Does stuff',
      artifacts: [
        {
          type: 'script_include',
          fields: { name: 'MyUtils', api_name: 'MyUtils', script: 'var x;' },
        },
      ],
    };
    const result = normaliseBuildResponse(input);
    expect(result.name).toBe('My Build');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].fields['name']).toBe('MyUtils');
  });

  it('hoists flat artifact fields into the fields object when "fields" key is absent', () => {
    const input = {
      name: 'Flat Build',
      description: '',
      artifacts: [
        { type: 'script_include', name: 'FlatUtils', api_name: 'FlatUtils', script: 'var y;' },
      ],
    };
    const result = normaliseBuildResponse(input);
    expect(result.artifacts[0].fields['name']).toBe('FlatUtils');
    expect(result.artifacts[0].fields['script']).toBe('var y;');
  });

  it('parses optional scope object', () => {
    const input = {
      name: 'Scoped Build',
      description: '',
      scope: { prefix: 'x_co_app', name: 'My App', version: '2.0.0', vendor: 'Acme' },
      artifacts: [],
    };
    const result = normaliseBuildResponse(input);
    expect(result.scope).toEqual({
      prefix: 'x_co_app',
      name: 'My App',
      version: '2.0.0',
      vendor: 'Acme',
    });
  });

  it('omits scope when prefix is missing', () => {
    const input = {
      name: 'No Scope Build',
      description: '',
      scope: { name: 'Missing Prefix App' }, // no prefix
      artifacts: [],
    };
    const result = normaliseBuildResponse(input);
    expect(result.scope).toBeUndefined();
  });

  it('throws when "name" field is missing', () => {
    expect(() => normaliseBuildResponse({ description: '', artifacts: [] })).toThrow('name');
  });

  it('throws when "artifacts" is not an array', () => {
    expect(() =>
      normaliseBuildResponse({ name: 'Build', description: '', artifacts: 'bad' })
    ).toThrow('artifacts');
  });

  it('throws when an artifact is missing its "type" field', () => {
    expect(() =>
      normaliseBuildResponse({ name: 'Build', description: '', artifacts: [{ fields: {} }] })
    ).toThrow('type');
  });
});

// ─── parseBuildResponse ───────────────────────────────────────────────────────

describe('parseBuildResponse', () => {
  it('parses a JSON-fenced LLM response', () => {
    const raw = '```json\n{"name":"Test","description":"","artifacts":[]}\n```';
    const result = parseBuildResponse(raw);
    expect(result.name).toBe('Test');
  });

  it('parses a raw JSON response without fencing', () => {
    const raw = '{"name":"Direct","description":"ok","artifacts":[]}';
    const result = parseBuildResponse(raw);
    expect(result.name).toBe('Direct');
  });

  it('throws a SyntaxError for invalid JSON', () => {
    expect(() => parseBuildResponse('not json at all')).toThrow();
  });
});

// ─── diffBuilds ───────────────────────────────────────────────────────────────

function makeArtifact(type: string, name: string, extra: Record<string, unknown> = {}): SNArtifact {
  return { type: type as SNArtifact['type'], fields: { name, ...extra } };
}

function makeBuild(artifacts: SNArtifact[]): SNBuildResponse {
  return { name: 'Build', description: '', artifacts };
}

describe('diffBuilds', () => {
  it('treats all artifacts as added when previous is null', () => {
    const a = makeArtifact('script_include', 'MyUtils');
    const diff = diffBuilds(null, makeBuild([a]));
    expect(diff.added).toHaveLength(1);
    expect(diff.updated).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('detects a newly added artifact', () => {
    const prev = makeBuild([makeArtifact('script_include', 'OldUtils')]);
    const next = makeBuild([
      makeArtifact('script_include', 'OldUtils'),
      makeArtifact('script_include', 'NewUtils'),
    ]);
    const diff = diffBuilds(prev, next);
    expect(diff.added.map((a) => a.fields['name'])).toContain('NewUtils');
    expect(diff.updated).toHaveLength(0);
  });

  it('detects a removed artifact', () => {
    const prev = makeBuild([
      makeArtifact('script_include', 'Utils'),
      makeArtifact('script_include', 'Helpers'),
    ]);
    const next = makeBuild([makeArtifact('script_include', 'Utils')]);
    const diff = diffBuilds(prev, next);
    expect(diff.removed.map((a) => a.fields['name'])).toContain('Helpers');
  });

  it('detects an updated artifact when fields change', () => {
    const prev = makeBuild([makeArtifact('script_include', 'Utils', { script: 'var a;' })]);
    const next = makeBuild([makeArtifact('script_include', 'Utils', { script: 'var b;' })]);
    const diff = diffBuilds(prev, next);
    expect(diff.updated).toHaveLength(1);
    expect(diff.updated[0].fields['script']).toBe('var b;');
  });

  it('reports unchanged when fields are identical', () => {
    const artifact = makeArtifact('script_include', 'Utils', { script: 'var a;' });
    const prev = makeBuild([artifact]);
    const next = makeBuild([makeArtifact('script_include', 'Utils', { script: 'var a;' })]);
    const diff = diffBuilds(prev, next);
    expect(diff.added).toHaveLength(0);
    expect(diff.updated).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('distinguishes artifacts of different types with the same name', () => {
    const prev = makeBuild([makeArtifact('script_include', 'MyThing')]);
    const next = makeBuild([makeArtifact('business_rule', 'MyThing')]);
    const diff = diffBuilds(prev, next);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });
});
