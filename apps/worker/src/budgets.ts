import type {ChatRequest,ProviderAdapter} from '@homelab/providers';
export class TokenBudgetError extends Error{constructor(public readonly code:string){super(code);}}
export interface BudgetEvidence{mode:'output_only'|'hard_exact_preflight';source:string;input_tokens_reserved:number|null;max_output_tokens_reserved:number;total_tokens_limit:number|null;prior_tokens_used:number;}
function count(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
/** No byte/character/token estimate is substituted for an exact provider-frame preflight. */
export async function prepareInferenceBudget(adapter:ProviderAdapter,request:ChatRequest,totalLimit?:number,priorUsed=0):Promise<{request:ChatRequest;budget:BudgetEvidence}>{
 const desired=request.maxOutputTokens??4096;
 if(!Number.isSafeInteger(desired)||desired<1)throw new TokenBudgetError('invalid_output_token_limit');
 if(totalLimit===undefined)return {request,budget:{mode:'output_only',source:'provider_output_token_parameter',input_tokens_reserved:null,max_output_tokens_reserved:desired,total_tokens_limit:null,prior_tokens_used:priorUsed}};
 if(!count(totalLimit)||totalLimit<1||!count(priorUsed)||priorUsed>=totalLimit)throw new TokenBudgetError('token_budget_exhausted');
 if(!adapter.countRequestTokens)throw new TokenBudgetError('token_budget_preflight_unavailable');
 const remaining=totalLimit-priorUsed;
 let candidate:ChatRequest={...request,maxOutputTokens:Math.min(desired,remaining)};
 for(let attempt=0;attempt<4;attempt++){
  const measured=await adapter.countRequestTokens(candidate);
  if(measured.exact!==true||!count(measured.inputTokens)||typeof measured.source!=='string'||!measured.source.trim()||measured.source.length>200)throw new TokenBudgetError('token_budget_preflight_invalid');
  const outputAvailable=remaining-measured.inputTokens;
  if(outputAvailable<1)throw new TokenBudgetError('token_budget_prompt_exceeds_remaining');
  const output=Math.min(candidate.maxOutputTokens!,outputAvailable);
  if(output===candidate.maxOutputTokens)return {request:candidate,budget:{mode:'hard_exact_preflight',source:measured.source,input_tokens_reserved:measured.inputTokens,max_output_tokens_reserved:output,total_tokens_limit:totalLimit,prior_tokens_used:priorUsed}};
  candidate={...candidate,maxOutputTokens:output};
 }
 throw new TokenBudgetError('token_budget_preflight_unstable');
}
