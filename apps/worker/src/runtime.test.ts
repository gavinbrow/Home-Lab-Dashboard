import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "./hash.js";
import { assertTransition } from "./types.js";
import { parseCursor, encodeSse } from "../../api/src/modules/jobs/sse.js";

test("request hashing is insensitive to nested object insertion order", () => {
  assert.equal(digest({b:{y:2,x:1},a:[3,2]}), digest({a:[3,2],b:{x:1,y:2}}));
  assert.notEqual(digest({a:[3,2]}),digest({a:[2,3]}));
  assert.throws(() => digest({bad:undefined}));
});
test("terminal jobs cannot transition or replay through state changes", () => {
  for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) {
    assert.throws(() => assertTransition(state,"running"));
    assert.throws(() => assertTransition(state,"queued"));
  }
  assert.throws(() => assertTransition("cancelling","completed"));
  assertTransition("cancelling","interrupted");
});
test("SSE cursor preserves int64 precision and rejects unbounded inputs", () => {
  assert.equal(parseCursor("9007199254740993"),"9007199254740993");
  assert.throws(() => parseCursor("9223372036854775808"));
  assert.throws(() => parseCursor("1\nevent:command"));
  assert.throws(() => encodeSse("1","log\ndata:bad",{}));
  assert.equal(encodeSse("1","log",{text:"\nid: 999"}), 'id: 1\nevent: log\ndata: {"text":"\\nid: 999"}\n\n');
});

test("profile scope and budgets cannot expand via client context", async () => {
 const {checkProfile}=await import("./authority.js");
 const limits={max_tool_steps:3,wall_time_seconds:60,per_command_timeout_seconds:10,max_output_bytes:1024};
 const profile={instructions:"",tools:["run_command"],machine_ids:["machine"],workspace_ids:["workspace"],required_capabilities:[],limits};
 const context={execution_machine_id:"machine",workspace_id:"workspace",limits} as import("@homelab/contracts").RunContext;
 assert.doesNotThrow(()=>checkProfile(profile,context,"run_command"));
 assert.throws(()=>checkProfile(profile,{...context,workspace_id:"other"},"run_command"));
 assert.throws(()=>checkProfile(profile,context,"service.restart"));
 assert.throws(()=>checkProfile(profile,{...context,limits:{...limits,wall_time_seconds:61}},"run_command"));
});
