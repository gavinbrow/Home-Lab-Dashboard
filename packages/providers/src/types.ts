export type AdapterKind = 'openai-compatible' | 'ollama' | 'lm-studio' | 'vllm';
/** Immutable configuration from the submitted job; never resolve a newer endpoint. */
export interface ProviderSnapshot {
  id: string; revision: number; adapter: AdapterKind; baseUrl: string;
  runtimePoolId: string; credentialRef?: string;
  routing: 'local' | 'remote' | 'unknown';
  allowedAddresses: string[]; allowPrivateHttp: boolean; timeoutMs: number;
  privateCaPem?: string;
  maxModelConcurrency?: number;
  contextLength?: number;
}
export interface ToolDefinition {
  type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> };
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; index?: number }
export interface RejectedToolCall extends ToolCall { index:number; error:string }
export interface ChatImage { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  toolCallId?: string; toolName?: string; toolCalls?: ToolCall[];
  images?: ChatImage[];
}
export interface ChatRequest {
  model: string; messages: ChatMessage[]; tools?: ToolDefinition[];
  temperature?: number; maxOutputTokens?: number; jsonSchema?: Record<string, unknown>;
  thinking?: boolean;
  contextLength?: number;
}
export interface Usage {
  source: 'provider'; inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens: number | null; loadSeconds: number | null;
  promptEvaluationSeconds: number | null; generationSeconds: number | null;
  promptTokensPerSecond: number | null; decodeTokensPerSecond: number | null;
  raw?: Record<string, number>;
}
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'completed'; requestedModel: string; resolvedModel: string | null;
      finishReason: string | null; toolCalls: ToolCall[]; rejectedToolCalls?:RejectedToolCall[]; usage: Usage;
      wallSeconds: number; firstContentSeconds: number | null };
export interface ModelObservation {
  id: string; label: string; observedAt: string; source: string;
  residency: 'loaded' | 'unloaded' | 'unknown'; loadedInstances: { id: string; config: Record<string, unknown> }[];
  metadata: Record<string, unknown>;
  capabilities: { tools: 'claimed' | 'unknown'; images: 'claimed' | 'unknown' };
}
export interface RuntimeObservation {
  observedAt: string; residency: 'known' | 'unknown'; models: ModelObservation[];
  providerActiveRequests: null; reason?: string;
}
export type ManagementAction = 'load' | 'unload' | 'download' | 'download-status';
export interface ManagementInput {
  model?: string; instanceId?: string; jobId?: string;
  settings?: { contextLength?: number; evalBatchSize?: number; flashAttention?: boolean };
  onProgress?: (progress: Record<string, unknown>) => Promise<void>;
}
export interface ProviderAdapter {
  discoverModels(signal?: AbortSignal): Promise<ModelObservation[]>;
  getRuntimeState(signal?: AbortSignal): Promise<RuntimeObservation>;
  getCapabilities(): { tools: 'unknown'; images: 'unknown'; cancellation: 'client-abort-only';tokenBudget?:'exact-preflight'|'unsupported' };
  countRequestTokens?(request:ChatRequest):Promise<{inputTokens:number;source:string;exact:true}>;
  getServerVersion?(signal?: AbortSignal): Promise<string | null>;
  streamChat(request: ChatRequest, options?: { signal?: AbortSignal }): AsyncIterable<ChatEvent>;
  manage(action: ManagementAction, input: ManagementInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export class ProviderError extends Error {
  readonly statusCode:number;
  constructor(public readonly code: 'invalid-config' | 'destination-denied' | 'upstream-http' | 'invalid-response' | 'interrupted' | 'unsupported', message: string, public readonly status?: number, public readonly responseComplete = false) { super(message); this.name = 'ProviderError';this.statusCode=code==='invalid-config'?400:code==='destination-denied'?403:code==='unsupported'?422:code==='interrupted'?503:502; }
}
