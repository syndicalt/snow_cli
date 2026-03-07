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
 * Run a test suite via the ServiceNow CICD API (sn_cicd plugin).
 *
 * Flow:
 *   1. POST /api/sn_cicd/testsuite/run?test_suite_sys_id=<id>  → get progress + results links
 *   2. Poll GET /api/sn_cicd/progress/<id>  until terminal status (0=success, 3=failed, 4=cancelled)
 *   3. GET /api/sn_cicd/testsuite/results/<id>  → parse test results
 *
 * Requires the user to have the sn_cicd role on the instance.
 */
export async function runATFSuite(
  client: ServiceNowClient,
  suiteSysId: string
): Promise<ATFRunResult> {
  // 1. Kick off the run
  const startRes = await client.post<{
    links?: {
      progress?: { id?: string };
      results?: { id?: string };
    };
    status?: string;
    status_label?: string;
  }>('/api/sn_cicd/testsuite/run', undefined, {
    params: { test_suite_sys_id: suiteSysId },
  });

  // Handle both direct and result-wrapped response shapes across SN versions.
  // Some versions only return a progress link; the results use the same ID.
  const resData = (startRes as Record<string, unknown>);
  const inner   = (resData['result'] ?? resData) as Record<string, unknown>;
  const links   = inner['links'] as Record<string, unknown> | undefined;

  const progressId =
    ((links?.['progress'] as Record<string, unknown>)?.['id'] as string | undefined) ??
    ((links?.['results']  as Record<string, unknown>)?.['id'] as string | undefined);

  if (!progressId) {
    throw new Error(
      'CICD API did not return a progress link.\n' +
      'Raw response: ' + JSON.stringify(startRes, null, 2) + '\n' +
      'Ensure the sn_cicd plugin is active and your user has the sn_cicd role.'
    );
  }

  // Results use the same ID as progress (some SN versions omit a separate results link)
  const resultsId = ((links?.['results'] as Record<string, unknown>)?.['id'] as string | undefined) ?? progressId;

  // 2. Poll progress until terminal
  // Status codes: 0=pending, 1=running, 2=complete/success, 3=failed, 4=cancelled
  const TERMINAL = new Set(['2', '3', '4']);
  const POLL_MS = 5000;
  const MAX_POLLS = 120; // ~10 min max (PDIs can be slow)

  let done = false;
  let lastProgressRes: Record<string, unknown> = {};
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const progress = await client.get<Record<string, unknown>>(
      `/api/sn_cicd/progress/${progressId}`
    );
    // Unwrap result wrapper if present
    lastProgressRes = ((progress['result'] ?? progress) as Record<string, unknown>);
    if (TERMINAL.has(String(lastProgressRes['status'] ?? ''))) {
      done = true;
      break;
    }
  }

  if (!done) {
    throw new Error('ATF test suite timed out after 10 minutes');
  }

  // 3. Fetch aggregate counts from the CICD results endpoint.
  //    The completed progress response includes a results link with the correct ID.
  const progressLinks = lastProgressRes['links'] as Record<string, unknown> | undefined;
  const finalResultsId =
    ((progressLinks?.['results'] as Record<string, unknown>)?.['id'] as string | undefined) ??
    resultsId;

  const resultsRes = await client.get<Record<string, unknown>>(
    `/api/sn_cicd/testsuite/results/${finalResultsId}`
  );

  const resultData = ((resultsRes['result'] ?? resultsRes) as Record<string, unknown>);
  const successCount = parseInt(String(resultData['rolledup_test_success_count'] ?? 0), 10);
  const failureCount = parseInt(String(resultData['rolledup_test_failure_count'] ?? 0), 10)
                     + parseInt(String(resultData['rolledup_test_error_count']   ?? 0), 10);
  const skipCount    = parseInt(String(resultData['rolledup_test_skip_count']    ?? 0), 10);
  const total        = successCount + failureCount + skipCount;

  // The results link inside resultData points to the sys_atf_test_suite_result record.
  // Use its sys_id to query per-test details via the Table API.
  const suiteResultLinks = resultData['links'] as Record<string, unknown> | undefined;
  const suiteResultSysId =
    ((suiteResultLinks?.['results'] as Record<string, unknown>)?.['id'] as string | undefined) ??
    finalResultsId;

  let testResults: Array<{ name: string; status: string; message?: string }> = [];
  try {
    const rows = await client.queryTable('sys_atf_result', {
      sysparmQuery: `test_suite_result=${suiteResultSysId}`,
      sysparmFields: 'test,status,output',
      sysparmLimit: 200,
      sysparmDisplayValue: true,
    });
    testResults = rows.map(r => {
      const testField = r['test'];
      const name = testField && typeof testField === 'object'
        ? String((testField as Record<string, unknown>)['display_value'] ?? '(unknown)')
        : String(testField ?? '(unknown)');
      const statusStr = String(r['status'] ?? '');
      return {
        name,
        status: statusStr === 'success' || statusStr === 'pass' ? 'success' : 'failure',
        message: r['output'] ? String(r['output']) : undefined,
      };
    });
  } catch {
    // Table query unavailable — build synthetic results from aggregate counts so the
    // caller still gets correct pass/fail totals even without per-test detail.
    testResults = Array.from({ length: successCount }, (_, i) => ({
      name: `Test ${i + 1}`,
      status: 'success' as const,
    }));
    for (let i = 0; i < failureCount; i++) {
      testResults.push({ name: `Test ${successCount + i + 1}`, status: 'failure' });
    }
  }

  return {
    status: String(resultData['test_suite_status'] ?? resultData['status'] ?? 'unknown'),
    passed: successCount,
    failed: failureCount,
    total,
    testResults,
  };
}
