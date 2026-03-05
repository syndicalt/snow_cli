export type AuthType = 'basic' | 'oauth';

export interface BasicAuth {
  type: 'basic';
  username: string;
  password: string;
}

export interface OAuthAuth {
  type: 'oauth';
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  tokenExpiry?: number;
}

export type Auth = BasicAuth | OAuthAuth;

export interface Instance {
  alias: string;
  url: string;
  auth: Auth;
}

export interface Config {
  activeInstance?: string;
  instances: Record<string, Instance>;
  ai?: AIConfig;
}

// ServiceNow Table API types
export interface TableRecord {
  sys_id: string;
  [key: string]: unknown;
}

export interface TableResponse<T = TableRecord> {
  result: T | T[];
}

export interface QueryOptions {
  sysparmQuery?: string;
  sysparmFields?: string;
  sysparmLimit?: number;
  sysparmOffset?: number;
  sysparmDisplayValue?: boolean | 'all';
  sysparmExcludeReferenceLink?: boolean;
}

export interface TableField {
  name: string;
  label: string;
  type: string;
  maxLength?: number;
  mandatory?: boolean;
  readOnly?: boolean;
  reference?: string;
  defaultValue?: string;
}

export interface TableSchema {
  name: string;
  label: string;
  fields: TableField[];
}

// LLM / AI provider types
export type LLMProviderName = 'openai' | 'anthropic' | 'xai' | 'ollama';

export interface LLMProviderConfig {
  model: string;
  apiKey?: string;   // not required for ollama
  baseUrl?: string;  // custom endpoint override
}

export interface AIConfig {
  activeProvider?: LLMProviderName;
  providers: Partial<Record<LLMProviderName, LLMProviderConfig>>;
}

// ServiceNow artifact types the LLM can generate
export type SNArtifactType =
  | 'script_include'
  | 'business_rule'
  | 'client_script'
  | 'ui_action'
  | 'ui_page'
  | 'scheduled_job'
  | 'table'
  | 'decision_table'
  | 'flow_action';

export interface SNArtifact {
  type: SNArtifactType;
  // Fields are typed as unknown to allow nested arrays/objects for complex artifacts
  // (table columns, decision table rules, flow action inputs/outputs).
  // Consumers cast specific fields as needed.
  fields: Record<string, unknown>;
}

/**
 * Scoped application namespace. When present on a build response the CLI
 * generates a sys_app record and stamps sys_scope on every artifact.
 */
export interface SNScope {
  /** Fully-qualified scope prefix, e.g. "x_myco_myapp" */
  prefix: string;
  /** Human-readable application name */
  name: string;
  /** Semantic version string, e.g. "1.0.0" */
  version: string;
  vendor?: string;
}

export interface SNBuildResponse {
  name: string;
  description: string;
  /** Present when the LLM determines the build warrants a scoped application. */
  scope?: SNScope;
  artifacts: SNArtifact[];
}
