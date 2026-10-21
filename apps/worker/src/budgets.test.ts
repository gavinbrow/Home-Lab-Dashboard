import test from 'node:test';import assert from 'node:assert/strict';
import type {ProviderAdapter} from '@homelab/providers';
import {prepareInferenceBudget} from './budgets.js';
test('hard token limit rejects unsupported and oversized input before generation',async()=>{
 let generation=0;const adapter={streamChat:async function*(){generation++;}} as unknown as ProviderAdapter;
 await assert.rejects(prepareInferenceBudget(adapter,{model:'fixture',messages:[{role:'user',content:'oversized'}],maxOutputTokens:10},10),/preflight_unavailable/);
 adapter.countRequestTokens=async()=>({inputTokens:11,source:'explicit-test-tokenizer/full-framing',exact:true});
 await assert.rejects(prepareInferenceBudget(adapter,{model:'fixture',messages:[{role:'user',content:'oversized'}],maxOutputTokens:10},10),/prompt_exceeds/);assert.equal(generation,0);
 adapter.countRequestTokens=async()=>({inputTokens:NaN,source:'bad',exact:true});await assert.rejects(prepareInferenceBudget(adapter,{model:'fixture',messages:[],maxOutputTokens:10},20),/preflight_invalid/);
});
test('exact input+output reservation binds the final complete request',async()=>{
 const seen:any[]=[];const adapter={countRequestTokens:async(request:any)=>{seen.push(structuredClone(request));return {inputTokens:7,source:'explicit-test-tokenizer/full-framing',exact:true as const};}} as ProviderAdapter;
 const prepared=await prepareInferenceBudget(adapter,{model:'fixture',messages:[{role:'user',content:'x'}],tools:[{type:'function',function:{name:'echo',parameters:{type:'object'}}}],maxOutputTokens:10},20,5);
 assert.equal(prepared.request.maxOutputTokens,8);assert.deepEqual(seen.at(-1),prepared.request);assert.equal(prepared.budget.input_tokens_reserved!+prepared.budget.max_output_tokens_reserved+prepared.budget.prior_tokens_used,20);
});
