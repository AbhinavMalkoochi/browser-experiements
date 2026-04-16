import OpenAI from 'openai';
import { ENV } from '../env.js';
import { estimateCostUsd } from './pricing.js';
import type { LlmUsage } from './types.js';

export const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }> }
  | { role: 'assistant'; content: string };

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
  responseFormatJson?: boolean;
}

export interface ChatResult<T = string> {
  model: string;
  text: string;
  json?: T;
  usage: LlmUsage;
  raw: OpenAI.Chat.Completions.ChatCompletion;
}

export async function chat<T = unknown>(opts: ChatOptions): Promise<ChatResult<T>> {
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
    model: opts.model,
    messages: opts.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.jsonSchema) {
    params.response_format = {
      type: 'json_schema',
      json_schema: {
        name: opts.jsonSchema.name,
        schema: opts.jsonSchema.schema,
        strict: opts.jsonSchema.strict ?? true,
      },
    };
  } else if (opts.responseFormatJson) {
    params.response_format = { type: 'json_object' };
  }
  const res = await openai.chat.completions.create(params);
  const msg = res.choices[0]?.message;
  const text = msg?.content ?? '';
  let json: T | undefined;
  if (opts.jsonSchema || opts.responseFormatJson) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      // leave undefined; caller will surface error
    }
  }
  const usage: LlmUsage = {
    model: opts.model,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
  usage.costUsd = estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens);
  return { model: opts.model, text, json, usage, raw: res };
}

export function userTextImage(text: string, imageDataUrl: string, detail: 'low' | 'high' | 'auto' = 'high'): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: imageDataUrl, detail } },
    ],
  };
}
