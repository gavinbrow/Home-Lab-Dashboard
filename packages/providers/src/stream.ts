import { Ajv } from 'ajv';
import { ProviderError, type ToolCall, type ToolDefinition, type Usage,type RejectedToolCall } from './types.js';

export async function* lines(response: Response): AsyncIterable<string> {
  if (!response.body) throw new ProviderError('invalid-response', 'Provider response has no body');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); if (buffer) yield buffer.replace(/\r$/, ''); return; }
      total += value.byteLength;
      if (total > 16 * 1024 * 1024) throw new ProviderError('invalid-response', 'Provider stream exceeds the response limit');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new ProviderError('invalid-response', 'Provider stream line exceeds the response limit');
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1); yield line;
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export async function* sse(response: Response): AsyncIterable<string> {
  let data: string[] = [];
  for await (const line of lines(response)) {
    if (line === '') { if (data.length) yield data.join('\n'); data = []; }
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  // An unterminated event is an incomplete upstream response, never a tool call.
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('invalid-response', 'Provider returned an invalid object');
  return value as Record<string, any>;
}
export function parse(value: string): Record<string, any> {
  try { return object(JSON.parse(value)); } catch { throw new ProviderError('invalid-response', 'Provider returned invalid JSON'); }
}
export function validateCalls(calls: ToolCall[], tools: ToolDefinition[] = []): {toolCalls:ToolCall[];rejectedToolCalls:RejectedToolCall[]} {
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  const seen = new Set<string>();
  const result:{toolCalls:ToolCall[];rejectedToolCalls:RejectedToolCall[]}={toolCalls:[],rejectedToolCalls:[]};
  for (const [index,call] of calls.entries()) {
    const tool = tools.find(candidate => candidate.function.name === call.name);
    if (!call.id || seen.has(call.id)||!call.name) throw new ProviderError('invalid-response', 'Provider returned an unidentifiable or duplicate tool call');
    seen.add(call.id);
    if(!tool){result.rejectedToolCalls.push({...call,index,error:'Tool name was not offered for this inference'});continue;}
    const valid=ajv.compile(tool.function.parameters);
    if(!valid(call.arguments))result.rejectedToolCalls.push({...call,index,error:`Arguments failed their declared schema: ${ajv.errorsText(valid.errors,{dataVar:'arguments'})}`.slice(0,512)});
    else result.toolCalls.push({...call,index});
  }
  return result;
}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function usage(raw: Record<string, any>, ollama: boolean): Usage {
  const input = number(ollama ? raw.prompt_eval_count : raw.prompt_tokens);
  const output = number(ollama ? raw.eval_count : raw.completion_tokens);
  const cached = number(ollama ? raw.prompt_eval_cached_count : raw.prompt_tokens_details?.cached_tokens);
  const promptSeconds = ollama && number(raw.prompt_eval_duration) !== null ? raw.prompt_eval_duration / 1e9 : null;
  const generationSeconds = ollama && number(raw.eval_duration) !== null ? raw.eval_duration / 1e9 : null;
  const measurements: Record<string,number> = {};
  for (const key of ollama ? ['prompt_eval_count','prompt_eval_cached_count','eval_count','total_duration','load_duration','prompt_eval_duration','eval_duration'] : ['prompt_tokens','completion_tokens','total_tokens']) if (number(raw[key])!==null) measurements[key]=raw[key];
  if (!ollama && cached !== null) measurements.cached_tokens = cached;
  return { source: 'provider', raw: measurements, inputTokens: input, outputTokens: output, cachedInputTokens: cached,
    loadSeconds: ollama && number(raw.load_duration) !== null ? raw.load_duration / 1e9 : null,
    promptEvaluationSeconds: promptSeconds, generationSeconds,
    promptTokensPerSecond: input !== null && cached !== null && input >= cached && promptSeconds !== null && promptSeconds > 0 ? (input - cached) / promptSeconds : null,
    decodeTokensPerSecond: output !== null && generationSeconds !== null && generationSeconds > 0 ? output / generationSeconds : null };
}
