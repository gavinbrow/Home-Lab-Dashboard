import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionDefinitionSchema, assertTarget, canonicalHash, resolveCommand, resolveParameters } from './definition.js';
import { verificationPassed } from '@homelab/actions/handler';
const machine='11111111-1111-4111-8111-111111111111';
const workspace='22222222-2222-4222-8222-222222222222';
const definition=()=>ActionDefinitionSchema.parse({schema_version:1,machine_ids:[machine],workspace_ids:[workspace],parameters:{suite:{type:'enum',values:['unit','integration']},workers:{type:'integer',minimum:1,maximum:8}},command:{executable:'/usr/bin/test-runner',args:[{literal:'--suite'},{parameter:'suite'},{literal:'--workers'},{parameter:'workers'}],cwd_policy:'workspace_root'},limits:{}});
test('parameters become complete discrete argv elements without shell substitution',()=>{
  const d=definition();
  assert.deepEqual(resolveCommand(d.command!,resolveParameters(d,{suite:'unit',workers:2})).args,['--suite','unit','--workers','2']);
});
test('injection, unknown, missing, and out of range parameters fail closed',()=>{
  for(const values of [{suite:'unit; touch /tmp/x',workers:1},{suite:'unit',workers:9},{suite:'unit',workers:'2'},{suite:'unit'},{suite:'unit',workers:1,extra:true}]) assert.throws(()=>resolveParameters(definition(),values));
});
test('target restrictions require exact enrolled machine and workspace',()=>{
  const d=definition();
  assert.doesNotThrow(()=>assertTarget(d,{machine_id:machine,workspace_id:workspace,profile_id:null}));
  assert.throws(()=>assertTarget(d,{machine_id:workspace,workspace_id:workspace,profile_id:null}));
  assert.throws(()=>assertTarget(d,{machine_id:machine,workspace_id:null,profile_id:null}));
});
test('shell and native admin executables cannot be disguised as saved commands',()=>{
  for(const executable of ['/bin/sh','C:\\Windows\\System32\\cmd.exe','/usr/bin/systemctl','/usr/bin/docker']) assert.equal(ActionDefinitionSchema.safeParse({...definition(),command:{...definition().command,executable}}).success,false);
});
test('fixed definition cannot contain undeclared interpolation fields',()=>{
  assert.equal(ActionDefinitionSchema.safeParse({...definition(),command:{...definition().command,args:[{parameter:'unknown'}]}}).success,false);
});
test('request hashes remain stable across key order and distinguish changed target',()=>{
  assert.equal(canonicalHash({a:1,b:{d:2,c:3}}),canonicalHash({b:{c:3,d:2},a:1}));
  assert.notEqual(canonicalHash({target:machine}),canonicalHash({target:workspace}));
});
test('bounded string fields reject hostile regular expressions and metacharacters',()=>{
  const base=definition();
  const d=ActionDefinitionSchema.parse({...base,command:{...base.command,args:[{parameter:'label'}]},parameters:{label:{type:'string',pattern:'^[A-Za-z0-9 _.-]+$',max_length:30}}});
  assert.deepEqual(resolveParameters(d,{label:'safe label-1'}),{label:'safe label-1'});
  for(const label of ['x; reboot','$(reboot)','`reboot`','x\ny','x|y','--dangerous-option']) assert.throws(()=>resolveParameters(d,{label}));
  assert.equal(ActionDefinitionSchema.safeParse({...d,parameters:{label:{type:'string',pattern:'^(a+)+$',max_length:1024}}}).success,false);
});
test('custom command environments cannot bypass the host allowlist',()=>{
  const d=definition();
  assert.equal(ActionDefinitionSchema.safeParse({...d,command:{...d.command,env:{LD_PRELOAD:'/tmp/unapproved.so'}}}).success,false);
});
test('verification compares actual exit evidence, including an explicitly expected nonzero exit',()=>{
  assert.equal(verificationPassed({state:'known',operation_id:'fixture',status:'failed',exit_code:1},1),true);
  assert.equal(verificationPassed({state:'known',operation_id:'fixture',status:'rejected',exit_code:1},1),false);
  assert.equal(verificationPassed({state:'known',operation_id:'fixture',status:'succeeded'},0),false);
});
