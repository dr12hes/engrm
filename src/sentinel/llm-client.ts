/**
 * OpenAI-compatible LLM client for Sentinel.
 *
 * Supports OpenAI, Anthropic (via Messages API wrapper),
 * xAI, Mistral, Ollama, and any OpenAI-compatible endpoint.
 */

import type {
  LlmConfig,
  ChatMessage,
  ChatCompletionResponse,
} from "./types.js";

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434/v1",
};

/**
 * Call an LLM with chat messages and return the response.
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[]
): Promise<ChatCompletionResponse> {
  if (config.provider === "anthropic") {
    return callAnthropic(config, messages);
  }

  // OpenAI-compatible endpoint (OpenAI, xAI, Mistral, Ollama, custom)
  return callOpenAICompatible(config, messages);
}

/**
 * Call an OpenAI-compatible /v1/chat/completions endpoint.
 */
async function callOpenAICompatible(
  config: LlmConfig,
  messages: ChatMessage[]
): Promise<ChatCompletionResponse> {
  const baseUrl =
    config.baseUrl?.replace(/\/$/, "") ??
    DEFAULT_ENDPOINTS[config.provider] ??
    DEFAULT_ENDPOINTS.openai!;

  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.1,
    max_tokens: config.maxTokens ?? 1024,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
    model: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };

  const choice = data.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error("LLM returned empty response");
  }

  return {
    content: choice.message.content,
    model: data.model,
    usage: data.usage,
  };
}

/**
 * Call Anthropic's Messages API (different format from OpenAI).
 */
async function callAnthropic(
  config: LlmConfig,
  messages: ChatMessage[]
): Promise<ChatCompletionResponse> {
  const baseUrl =
    config.baseUrl?.replace(/\/$/, "") ?? DEFAULT_ENDPOINTS.anthropic!;
  const url = `${baseUrl}/v1/messages`;

  // Extract system message (Anthropic uses separate system parameter)
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    model: config.model,
    messages: nonSystem.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    max_tokens: config.maxTokens ?? 1024,
    temperature: config.temperature ?? 0.1,
  };

  if (systemMsg) {
    body.system = systemMsg.content;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Anthropic API error ${response.status}: ${text.slice(0, 200)}`
    );
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
    model: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };

  const text =
    data.content?.find((c) => c.type === "text")?.text ?? "";
  if (!text) {
    throw new Error("Anthropic returned empty response");
  }

  return {
    content: text,
    model: data.model,
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens:
            data.usage.input_tokens + data.usage.output_tokens,
        }
      : undefined,
  };
}
