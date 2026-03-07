import type { ServiceNowClient } from './client.js';
import type { LLMProvider, LLMMessage } from './llm.js';
import { extractJSON } from './llm.js';
import type { SNBuildResponse } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ATFTestStep {
  order: number;
  script: string; // server-side GlideScript run in ServiceNow
}

export interface ATFTest {
  name: string;
  short_description: string;
  steps: ATFTestStep[];
}

export interface ATFSuite {
  name: string;
  description: string;
  tests: ATFTest[];
}

export interface ATFPushResult {
  suiteSysId: string;
  suiteUrl: string;
  testCount: number;
  stepCount: number;
}

export interface ATFRunResult {
  status: string;
  passed: number;
  failed: number;
  total: number;
  testResults: Array<{ name: string; status: string; message?: string }>;
}

// ---------------------------------------------------------------------------
// System prompt for ATF generation
// ---------------------------------------------------------------------------

export const ATF_SYSTEM_PROMPT = `
You are a ServiceNow Automated Test Framework (ATF) expert. Generate a practical test suite for a given ServiceNow application or set of artifacts.

Respond ONLY with a JSON object (optionally wrapped in a \`\`\`json code fence). No prose before or after.

Schema:
\`\`\`json
{
  "name": "Test suite name",
  "description": "What these tests cover",
  "tests": [
    {
      "name": "Test name",
      "short_description": "What this test verifies",
      "steps": [
        {
          "order": 100,
          "script": "// Server-side GlideScript\\ngs.assertTrue(condition, 'Failure message');"
        }
      ]
    }
  ]
}
\`\`\`

Rules:
- Each step runs as a server-side GlideScript in ServiceNow (using "Run server side script" ATF step type)
- Assertions: use gs.assertTrue(condition, 'message') and gs.assertFalse(condition, 'message')
- Use GlideRecord to insert, query, and verify data in tests
- Tests must be independent — each creates its own test data
- Always clean up test records at the end of each test (gr.deleteRecord())
- Generate 3–5 tests total with 2–4 steps each
- Test realistic scenarios: create records, verify field values, trigger business rules, test script include methods
- Steps within a test run sequentially; use global JS variables to pass data between steps
- All scripts must be ES5 (var only, no const/let, no arrow functions)

Example step that creates and verifies a record:
\`\`\`javascript
var gr = new GlideRecord('incident');
gr.initialize();
gr.setValue('short_description', 'ATF Test Incident');
gr.setValue('urgency', '2');
var sysId = gr.insert();
gs.assertTrue(sysId !== null && sysId !== '', 'Failed to create incident');

// Verify the record
var verify = new GlideRecord('incident');
gs.assertTrue(verify.get(sysId), 'Could not retrieve created incident');
gs.assertTrue(verify.getValue('urgency') === '2', 'Urgency not set correctly');
verify.deleteRecord();
\`\`\`
`.trim();

// ---------------------------------------------------------------------------
// ATF helpers
// ---------------------------------------------------------------------------

/**
 * Find the sys_id of the "Run server side script" ATF step config.
 * Returns null if the table is inaccessible or no matching config is found.
 */
export async function getServerScriptStepConfig(
  client: ServiceNowClient
): Promise<string | null> {
  try {
    const records = await client.queryTable('sys_atf_step_config', {
      sysparmQuery: 'nameCONTAINSserver side^ORnameCONTAINSrun server^ORname=Server Side Script',
      sysparmFields: 'sys_id,name',
      sysparmLimit: 10,
    });
    if (records.length === 0) return null;
    // Prefer exact match
    const exact = records.find(r =>
      String(r['name']).toLowerCase().includes('server side')
    );
    return String((exact ?? records[0])['sys_id']);
  } catch {
    return null;
  }
}

/**
 * Generate an ATF test suite via LLM.
 * Summarises the build artifacts into a readable description, then calls the LLM.
 */
export async function generateATFTests(
  provider: LLMProvider,
  build: SNBuildResponse
): Promise<ATFSuite> {
  const artifactLines = build.artifacts.map(a => {
    const name = String(a.fields['name'] ?? a.type);
    const table = String(a.fields['table'] ?? '');
    const when = String(a.fields['when'] ?? '');
    const scriptPreview = String(a.fields['script'] ?? '').slice(0, 200);
    let desc = `  - ${a.type}: ${name}`;
    if (table) desc += ` (table: ${table})`;
    if (when) desc += ` [${when}]`;
    if (scriptPreview) desc += `\n    Script (first 200 chars): ${scriptPreview}`;
    return desc;
  });

  const scopeLine = build.scope
    ? `Application scope: ${build.scope.prefix} (${build.scope.name} v${build.scope.version})`
    : 'Global scope';

  const userMessage =
    `Generate ATF tests for the following ServiceNow application:\n\n` +
    `Name: ${build.name}\n` +
    `Description: ${build.description}\n` +
    `${scopeLine}\n\n` +
    `Artifacts to test:\n${artifactLines.join('\n')}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: ATF_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const raw = await provider.complete(messages);
  const json = extractJSON(raw);
  return JSON.parse(json) as ATFSuite;
}

/**
 * Push an ATF suite (suite → tests → steps) to the instance.
 */
export async function pushATFSuite(
  client: ServiceNowClient,
  suite: ATFSuite,
  stepConfigSysId: string
): Promise<ATFPushResult> {
  // Create the test suite
  const suiteRecord = await client.createRecord('sys_atf_test_suite', {
    name: suite.name,
    description: suite.description,
    active: true,
  });
  const suiteSysId = String(suiteRecord.sys_id);
  const suiteUrl = `${client.getInstanceUrl()}/nav_to.do?uri=sys_atf_test_suite.do?sys_id=${suiteSysId}`;

  let stepCount = 0;

  for (let t = 0; t < suite.tests.length; t++) {
    const test = suite.tests[t];

    const testRecord = await client.createRecord('sys_atf_test', {
      name: test.name,
      short_description: test.short_description,
      active: true,
    });
    const testSysId = String(testRecord.sys_id);

    // Associate test with suite
    await client.createRecord('sys_atf_test_suite_test', {
      test_suite: suiteSysId,
      test: testSysId,
      order: t * 100,
    });

    // Create steps
    for (const step of test.steps) {
      await client.createRecord('sys_atf_step', {
        test: testSysId,
        order: step.order,
        step_config: stepConfigSysId,
        inputs: JSON.stringify({ script: step.script }),
      });
      stepCount++;
    }
  }

  return { suiteSysId, suiteUrl, testCount: suite.tests.length, stepCount };
}

/**
 * Run a test suite via the ATF API and return the result.
 */
export async function runATFSuite(
  client: ServiceNowClient,
  suiteSysId: string
): Promise<ATFRunResult> {
  const res = await client.post<{
    result: {
      status: string;
      test_suite_result: {
        tests_passed?: string;
        tests_failed?: string;
        total_tests?: string;
        test_results?: Array<{
          test_name?: string;
          status?: string;
          message?: string;
        }>;
      };
    };
  }>('/api/now/atf/test_suite/run', { id: suiteSysId });

  const r = res?.result?.test_suite_result ?? {};
  return {
    status: res?.result?.status ?? 'unknown',
    passed: parseInt(r.tests_passed ?? '0', 10),
    failed: parseInt(r.tests_failed ?? '0', 10),
    total: parseInt(r.total_tests ?? '0', 10),
    testResults: (r.test_results ?? []).map(t => ({
      name: t.test_name ?? '(unknown)',
      status: t.status ?? 'unknown',
      message: t.message,
    })),
  };
}
