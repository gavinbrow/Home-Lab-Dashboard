import { randomUUID } from 'node:crypto';
import { createTransport, normalizeEndpoint, type ProviderTransport } from './transport.js';
import { lines, object, parse, sse, usage, validateCalls } from './stream.js';
import { validateImages } from './images.js';
import { ProviderError, type ChatEvent, type ChatRequest, type ModelObservation, type ProviderAdapter, type ProviderSnapshot, type ToolCall } from './types.js';
export * from './types.js';
export { createTransport, normalizeEndpoint, type ProviderTransport } from './transport.js';
export { validateImages } from './images.js';
export { evaluateProbeValidity,probeValidity,refreshModelIdentity,resolveObservedModel,type CapabilityValidity } from './capabilities.js';

export function createProviderAdapter(snapshot: ProviderSnapshot, deps: { resolveCredential: (ref: string) => Promise<string>; transport?: ProviderTransport }): ProviderAdapter {
  normalizeEndpoint(snapshot.baseUrl);
  const transport = deps.transport ?? createTransport(snapshot, deps.resolveCredential);
  const ollama = snapshot.adapter === 'ollama'; const lm = snapshot.adapter === 'lm-studio';
  const json = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await transport.request(path, body, signal);
    let text = ''; for await (const line of lines(response)) text += line;
    const value=parse(text);if(value.error)throw new ProviderError('invalid-response','Provider returned an operation error',undefined,true);return value;
  };
  function model(raw: Record<string, any>, source: string): ModelObservation {
    const id = ollama ? raw.name : lm ? raw.key : raw.id;
    if (typeof id !== 'string' || !id) throw new ProviderError('invalid-response', 'Provider model has no identifier');
    const instances = lm && Array.isArray(raw.loaded_instances) ? raw.loaded_instances.map((i: any) => ({ id: String(i.id), config: object(i.config) })) : [];
    return { id, label: typeof raw.display_name === 'string' ? raw.display_name : id, observedAt: new Date().toISOString(), source,
      residency: lm && Array.isArray(raw.loaded_instances) ? (instances.length ? 'loaded' : 'unloaded') : 'unknown', loadedInstances: instances,
      metadata: { ...(typeof raw.size === 'number' ? { sizeBytes: raw.size } : {}), ...(typeof raw.size_bytes === 'number' ? { sizeBytes: raw.size_bytes } : {}), ...(typeof raw.digest === 'string' ? { digest: raw.digest } : {}), ...(raw.details ? { details: object(raw.details) } : {}),
        ...(raw.quantization && typeof raw.quantization==='object'?{quantization:raw.quantization}:{}),
        ...(typeof raw.max_context_length==='number'?{contextLimit:raw.max_context_length}:{}),
        ...(typeof raw.selected_variant==='string'?{variant:raw.selected_variant}:{}) },
      capabilities: { tools: raw.capabilities?.trained_for_tool_use === true ? 'claimed' : 'unknown', images: raw.capabilities?.vision === true ? 'claimed' : 'unknown' } };
  }
  return {
    getCapabilities: () => ({ tools: 'unknown', images: 'unknown', cancellation: 'client-abort-only',tokenBudget:'unsupported' }),
    async getServerVersion(signal) {
      if (!ollama) return null;
      const response = await json('/api/version',undefined,signal);
      return typeof response.version === 'string' ? response.version : null;
    },
    async discoverModels(signal) {
      const path = ollama ? '/api/tags' : lm ? '/api/v1/models' : '/v1/models';
      const raw = await json(path, undefined, signal); const list = ollama || lm ? raw.models : raw.data;
      if (!Array.isArray(list)) throw new ProviderError('invalid-response', 'Provider catalog is not an array');
      return list.map(item => model(object(item), path));
    },
    async getRuntimeState(signal) {
      if (!ollama && !lm) return { observedAt: new Date().toISOString(), residency: 'unknown', models: [], providerActiveRequests: null, reason: 'Compatible inference does not establish memory residency or external activity' };
      const path = ollama ? '/api/ps' : '/api/v1/models'; const raw = await json(path, undefined, signal);
      if (!Array.isArray(raw.models)) throw new ProviderError('invalid-response', 'Provider runtime list is not an array');
      return { observedAt: new Date().toISOString(), residency: lm && raw.models.some((item:any)=>!Array.isArray(item.loaded_instances)) ? 'unknown' : 'known', providerActiveRequests: null,
        models: raw.models.map((item: unknown) => { const result = model(object(item), path); if (ollama) result.residency = 'loaded'; return result; }) };
    },
    async *streamChat(request: ChatRequest, options = {}): AsyncIterable<ChatEvent> {
      const started = performance.now(); let first: number | null = null; let resolved: string | null = null;
      if(request.contextLength!==undefined&&(!Number.isInteger(request.contextLength)||request.contextLength<1||request.contextLength>4194304))throw new ProviderError('invalid-config','Context length must be a positive bounded integer');
      let imageBytes = 0;
      for (const message of request.messages) {
        const images = validateImages(message.images);
        if (images.length && message.role !== 'user') throw new ProviderError('invalid-config', 'Images may only accompany a user message');
        imageBytes += images.reduce((sum,image)=>sum+Buffer.from(image.base64,'base64').length,0);
      }
      if (imageBytes > 16*1024*1024) throw new ProviderError('invalid-config', 'Conversation images exceed the request byte limit');
      let reason: string | null = null; let finished = false; let ended = false; let rawUsage = {}; const calls: ToolCall[] = [];
      const messages = request.messages.map(message => ollama ? { role: message.role, content: message.content,
        ...(message.images?.length ? { images: message.images.map(image=>image.base64) } : {}),
        ...(message.toolName ? { tool_name: message.toolName } : {}), ...(message.toolCalls ? { tool_calls: message.toolCalls.map(c => ({ function: { name: c.name, arguments: c.arguments } })) } : {}) } : { role: message.role, content: message.images?.length ? [{ type:'text',text:message.content },...message.images.map(image=>({type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.base64}`}}))] : message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}), ...(message.toolCalls ? { tool_calls: message.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) });
      const body = { model: request.model, messages, stream: true, ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(ollama ? { ...(request.thinking!==undefined?{think:request.thinking}:{}), options: { ...(request.contextLength!==undefined?{num_ctx:request.contextLength}:{}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {}) }, ...(request.jsonSchema ? { format: request.jsonSchema } : {}) }
          : { stream_options: { include_usage: true }, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}), ...(request.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'result', schema: request.jsonSchema, strict: true } } } : {}) }) };
      const response = await transport.request(ollama ? '/api/chat' : '/v1/chat/completions', body, options.signal);
      const fragments = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const data of ollama ? lines(response) : sse(response)) {
        if (!data) continue;
        if (data === '[DONE]') { ended = true; break; }
        const chunk = parse(data); if (chunk.error) throw new ProviderError('invalid-response', 'Provider reported a generation error');
        if (typeof chunk.model === 'string') resolved = chunk.model;
        if (ollama) {
          if (typeof chunk.message?.content === 'string' && chunk.message.content) { first ??= (performance.now() - started) / 1000; yield { type: 'text', text: chunk.message.content }; }
          if (Array.isArray(chunk.message?.tool_calls)) for (const value of chunk.message.tool_calls) {
            const fn = object(value.function); calls.push({ id: typeof value.id === 'string' ? value.id : randomUUID(), name: String(fn.name), arguments: object(fn.arguments) });
          }
          if (chunk.done === true) { finished = true; ended = true; reason = typeof chunk.done_reason === 'string' ? chunk.done_reason : null; rawUsage = chunk; break; }
        } else {
          if (chunk.usage) rawUsage = object(chunk.usage);
          if (!Array.isArray(chunk.choices)) throw new ProviderError('invalid-response', 'Provider omitted stream choices');
          for (const choice of chunk.choices) {
            if (choice.index !== 0) throw new ProviderError('invalid-response', 'Multiple completion choices are unsupported');
            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content) { first ??= (performance.now() - started) / 1000; yield { type: 'text', text: delta.content }; }
            for (const call of delta.tool_calls ?? []) {
              if (!Number.isInteger(call.index) || call.index < 0) throw new ProviderError('invalid-response', 'Invalid tool-call index');
              const state = fragments.get(call.index) ?? { id: '', name: '', arguments: '' };
              if (typeof call.id === 'string') state.id += call.id;
              if (typeof call.function?.name === 'string') state.name += call.function.name;
              if (typeof call.function?.arguments === 'string') state.arguments += call.function.arguments;
              fragments.set(call.index, state);
            }
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) { reason = String(choice.finish_reason); finished = true; }
          }
        }
      }
      if (!finished || !ended) throw new ProviderError('interrupted', 'Provider stream ended before a complete response');
      if (reason === 'length' || reason === 'content_filter') { if (calls.length || fragments.size) throw new ProviderError('interrupted', 'Provider tool call was truncated or filtered', undefined, true); }
      let validated:ReturnType<typeof validateCalls>;
      try {
        for (const [index,fragment] of [...fragments.entries()].sort(([left],[right])=>left-right)) {
          if(index!==calls.length)throw new ProviderError('invalid-response','Provider tool-call ordering is incomplete');
          calls.push({ id: fragment.id, name: fragment.name, arguments: parse(fragment.arguments) });
        }
        validated=validateCalls(calls, request.tools);
      } catch { throw new ProviderError('invalid-response', 'Completed provider response contains invalid tool calls', undefined, true); }
      yield { type: 'completed', requestedModel: request.model, resolvedModel: resolved, finishReason: reason,
        toolCalls: validated.toolCalls,...(validated.rejectedToolCalls.length?{rejectedToolCalls:validated.rejectedToolCalls}:{}), usage: usage(rawUsage, ollama), wallSeconds: (performance.now() - started) / 1000, firstContentSeconds: first };
    },
    async manage(action, input, signal) {
      if (ollama) {
        if (!input.model) throw new ProviderError('invalid-config', 'Exact model ID required');
        if (action === 'load' || action === 'unload') return json('/api/generate', { model: input.model, stream: false, keep_alive: action === 'load' ? -1 : 0 }, signal);
        if (action === 'download') {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(input.model) || input.model.includes('://')) throw new ProviderError('invalid-config', 'Invalid model registry identifier');
          const response = await transport.request('/api/pull', { model: input.model, stream: true }, signal);
          let final: Record<string,unknown> | null = null;
          for await (const line of lines(response)) {
            if (!line) continue;
            const value = parse(line);
            if (value.error) throw new ProviderError('invalid-response','Provider download failed',undefined,true);
            const progress = { status: value.status, ...(typeof value.completed==='number'?{completed_bytes:value.completed}:{}), ...(typeof value.total==='number'?{total_bytes:value.total}:{}), ...(typeof value.digest==='string'?{digest:value.digest}:{}) };
            await input.onProgress?.(progress);
            if (value.status === 'success') { final=progress;break; }
          }
          if (!final) throw new ProviderError('interrupted','Download stream ended without confirmed completion');
          return final;
        }
        throw new ProviderError('unsupported', 'Ollama pull status is available only within its original request');
      }
      if (!lm) throw new ProviderError('unsupported', 'Management is unavailable for this adapter version');
      if (action === 'download-status') {
        if (!input.jobId) throw new ProviderError('invalid-config', 'Download job ID required');
        return json(`/api/v1/models/download/status/${encodeURIComponent(input.jobId)}`, undefined, signal);
      }
      const key = action === 'unload' ? 'instance_id' : 'model'; const value = action === 'unload' ? input.instanceId : input.model;
      if (!value) throw new ProviderError('invalid-config', 'Exact model or loaded instance ID required');
      if (action === 'download' && /[:\\]/.test(value)) throw new ProviderError('destination-denied', 'Downloads require a catalog identifier, not an arbitrary URL');
      const settings = input.settings;
      if (settings?.contextLength !== undefined && (!Number.isInteger(settings.contextLength) || settings.contextLength < 1 || settings.contextLength > 4_194_304) || settings?.evalBatchSize !== undefined && (!Number.isInteger(settings.evalBatchSize) || settings.evalBatchSize < 1 || settings.evalBatchSize > 65536)) throw new ProviderError('invalid-config','Invalid load configuration limits');
      return json(`/api/v1/models/${action}`, { [key]: value, ...(action === 'load' ? { echo_load_config: true,
        ...(settings?.contextLength!==undefined?{context_length:settings.contextLength}:{}),
        ...(settings?.evalBatchSize!==undefined?{eval_batch_size:settings.evalBatchSize}:{}),
        ...(settings?.flashAttention!==undefined?{flash_attention:settings.flashAttention}:{}) } : {}) }, signal);
    }
  };
}
