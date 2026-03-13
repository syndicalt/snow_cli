import { vi, describe, it, expect } from 'vitest';
import { validateBuild, generateUpdateSetXML, pushArtifacts } from '../../src/lib/update-set.js';
import type { SNBuildResponse, SNArtifact } from '../../src/types/index.js';
import type { ServiceNowClient } from '../../src/lib/client.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeScriptInclude(overrides: Partial<Record<string, unknown>> = {}): SNArtifact {
  return {
    type: 'script_include',
    fields: {
      name: 'MyUtils',
      api_name: 'MyUtils',
      script: 'var MyUtils = Class.create();',
      ...overrides,
    },
  };
}

function makeBusinessRule(overrides: Partial<Record<string, unknown>> = {}): SNArtifact {
  return {
    type: 'business_rule',
    fields: {
      name: 'Set Priority',
      table: 'incident',
      when: 'before',
      script: 'current.priority = 1;',
      ...overrides,
    },
  };
}

function makeMinimalBuild(artifacts: SNArtifact[] = []): SNBuildResponse {
  return {
    name: 'Test Build',
    description: 'A test build',
    artifacts,
  };
}

// ─── validateBuild ────────────────────────────────────────────────────────────

describe('validateBuild', () => {
  it('returns no errors for a valid script_include', () => {
    const build = makeMinimalBuild([makeScriptInclude()]);
    expect(validateBuild(build)).toEqual([]);
  });

  it('returns no errors for a valid business_rule', () => {
    const build = makeMinimalBuild([makeBusinessRule()]);
    expect(validateBuild(build)).toEqual([]);
  });

  it('reports missing fields for an invalid artifact', () => {
    const bad: SNArtifact = {
      type: 'script_include',
      fields: { name: 'Broken' }, // missing api_name and script
    };
    const errors = validateBuild(makeMinimalBuild([bad]));
    expect(errors).toHaveLength(1);
    expect(errors[0].missing).toContain('api_name');
    expect(errors[0].missing).toContain('script');
    expect(errors[0].name).toBe('Broken');
  });

  it('validates multiple artifacts and collects all errors', () => {
    const bad1: SNArtifact = { type: 'script_include', fields: { name: 'A' } };
    const bad2: SNArtifact = { type: 'business_rule', fields: { name: 'B' } };
    const errors = validateBuild(makeMinimalBuild([bad1, bad2]));
    expect(errors).toHaveLength(2);
  });

  it('returns no errors for an empty artifact list', () => {
    expect(validateBuild(makeMinimalBuild([]))).toEqual([]);
  });

  it('returns errors for a ui_page missing html field', () => {
    const bad: SNArtifact = { type: 'ui_page', fields: { name: 'MyPage' } };
    const errors = validateBuild(makeMinimalBuild([bad]));
    expect(errors[0].missing).toContain('html');
  });
});

// ─── generateUpdateSetXML ─────────────────────────────────────────────────────

describe('generateUpdateSetXML', () => {
  it('returns a string starting with the XML declaration', () => {
    const xml = generateUpdateSetXML(makeMinimalBuild([makeScriptInclude()]));
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  });

  it('contains an <unload> root element', () => {
    const xml = generateUpdateSetXML(makeMinimalBuild([makeScriptInclude()]));
    expect(xml).toContain('<unload ');
    expect(xml).toContain('</unload>');
  });

  it('includes a sys_update_set record with the build name', () => {
    const xml = generateUpdateSetXML(makeMinimalBuild([makeScriptInclude()]));
    expect(xml).toContain('<sys_update_set ');
    expect(xml).toContain('<name>Test Build</name>');
    expect(xml).toContain('<state>complete</state>');
  });

  it('wraps script content in CDATA', () => {
    const artifact = makeScriptInclude({ script: 'var x = 1; if (x < 2) { gs.info("ok"); }' });
    const xml = generateUpdateSetXML(makeMinimalBuild([artifact]));
    expect(xml).toContain('<![CDATA[');
  });

  it('includes the artifact table element (sys_script_include)', () => {
    const xml = generateUpdateSetXML(makeMinimalBuild([makeScriptInclude()]));
    expect(xml).toContain('<sys_script_include ');
  });

  it('includes a sys_app record when scope is present', () => {
    const build: SNBuildResponse = {
      ...makeMinimalBuild([makeScriptInclude()]),
      scope: { prefix: 'x_test_app', name: 'Test App', version: '1.0.0' },
    };
    const xml = generateUpdateSetXML(build);
    expect(xml).toContain('<sys_app ');
    expect(xml).toContain('x_test_app');
  });

  it('does not include sys_app when no scope', () => {
    const xml = generateUpdateSetXML(makeMinimalBuild([makeScriptInclude()]));
    expect(xml).not.toContain('<sys_app ');
  });

  it('XML-escapes build name with special characters', () => {
    const build = makeMinimalBuild([makeScriptInclude()]);
    build.name = 'Test & <Build>';
    const xml = generateUpdateSetXML(build);
    expect(xml).toContain('Test &amp; &lt;Build&gt;');
  });

  it('expands a table artifact into sys_db_object records', () => {
    const tableArtifact: SNArtifact = {
      type: 'table',
      fields: {
        name: 'x_test_my_table',
        label: 'My Table',
        columns: [
          { element: 'short_description', label: 'Short Description', internal_type: 'string' },
        ],
      },
    };
    const xml = generateUpdateSetXML(makeMinimalBuild([tableArtifact]));
    expect(xml).toContain('<sys_db_object ');
    expect(xml).toContain('<sys_dictionary ');
  });
});

// ─── pushArtifacts ────────────────────────────────────────────────────────────

describe('pushArtifacts', () => {
  function makeMockClient(overrides: Partial<ServiceNowClient> = {}): ServiceNowClient {
    return {
      queryTable: vi.fn().mockResolvedValue([]),
      createRecord: vi.fn().mockResolvedValue({ sys_id: 'new-sys-id' }),
      updateRecord: vi.fn().mockResolvedValue({ sys_id: 'existing-id' }),
      deleteRecord: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      getAxiosInstance: vi.fn(),
      getInstanceUrl: vi.fn(),
      ...overrides,
    } as unknown as ServiceNowClient;
  }

  it('creates a new artifact when none exists', async () => {
    const client = makeMockClient();
    const build = makeMinimalBuild([makeScriptInclude()]);
    const summary = await pushArtifacts(client, build);

    expect(summary.errors).toHaveLength(0);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].action).toBe('created');
    expect(summary.results[0].name).toBe('MyUtils');
  });

  it('updates an existing artifact when found by name query', async () => {
    const client = makeMockClient({
      queryTable: vi.fn().mockResolvedValue([{ sys_id: 'existing-id' }]),
    });
    const build = makeMinimalBuild([makeScriptInclude()]);
    const summary = await pushArtifacts(client, build);

    expect(summary.results[0].action).toBe('updated');
    expect(summary.results[0].sysId).toBe('existing-id');
  });

  it('records an error when createRecord throws', async () => {
    const client = makeMockClient({
      createRecord: vi.fn().mockRejectedValue(new Error('ServiceNow API error (500): Internal error')),
    });
    const build = makeMinimalBuild([makeScriptInclude()]);
    const summary = await pushArtifacts(client, build);

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].name).toBe('MyUtils');
    expect(summary.errors[0].error).toContain('Internal error');
  });

  it('records a permissionDenied flag for 403 errors', async () => {
    const client = makeMockClient({
      createRecord: vi.fn().mockRejectedValue(new Error('ServiceNow API error (403): Access denied')),
    });
    const build = makeMinimalBuild([makeScriptInclude()]);
    const summary = await pushArtifacts(client, build);

    expect(summary.errors[0].permissionDenied).toBe(true);
  });

  it('handles multiple artifacts and reports each result', async () => {
    const client = makeMockClient();
    const build = makeMinimalBuild([makeScriptInclude(), makeBusinessRule()]);
    const summary = await pushArtifacts(client, build);

    expect(summary.results).toHaveLength(2);
    expect(summary.errors).toHaveLength(0);
  });

  it('reports unknown artifact type as an error', async () => {
    const client = makeMockClient();
    const build: SNBuildResponse = {
      name: 'Bad Build',
      description: '',
      artifacts: [{ type: 'unknown_type' as never, fields: { name: 'Bad' } }],
    };
    const summary = await pushArtifacts(client, build);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].error).toContain('Unknown artifact type');
  });

  it('resolves scope before pushing when build has a scope', async () => {
    const client = makeMockClient();
    const build: SNBuildResponse = {
      ...makeMinimalBuild([makeScriptInclude()]),
      scope: { prefix: 'x_test_app', name: 'Test App', version: '1.0.0' },
    };
    const summary = await pushArtifacts(client, build);
    // createRecord is called at least once for scope AND the artifact
    expect(vi.mocked(client.createRecord).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(summary.errors).toHaveLength(0);
  });
});
