/**
 * Sentinel type definitions.
 */

export type AuditVerdict = "PASS" | "WARN" | "BLOCK" | "DRIFT";

export interface AuditResult {
  verdict: AuditVerdict;
  reason: string;
  rule?: string;
  severity?: "critical" | "high" | "medium" | "low";
}

export interface SentinelConfig {
  enabled: boolean;
  mode: "advisory" | "blocking";
  llm: LlmConfig;
  skipPatterns: string[];
  dailyLimit: number;
}

export interface LlmConfig {
  provider: "openai" | "anthropic" | "ollama" | "custom";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
