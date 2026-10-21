import test from 'node:test';import assert from 'node:assert/strict';
import {jobTiming} from '../../api/src/modules/jobs/timing.js';
const stamp=(seconds:number)=>new Date(seconds*1000);
test('server timing distinguishes queue, waiting, expired lease uncertainty and terminal intervals',()=>{
 const events=[{type:'job.state',payload:{state:'running'},created_at:stamp(2)},{type:'job.state',payload:{state:'waiting'},created_at:stamp(5)},{type:'job.state',payload:{state:'running'},created_at:stamp(8)}];
 const timing=jobTiming({created_at:stamp(0),last_heartbeat_at:stamp(10),last_lease_until:stamp(12)},events,stamp(20));assert.equal(timing.queue_ms,2000);assert.equal(timing.waiting_ms,3000);assert.equal(timing.active_ms,5000);assert.equal(timing.unconfirmed_ms,10000);assert.equal(timing.active_confirmed,false);assert.equal(timing.wall_ms,20000);
 const finished=jobTiming({created_at:stamp(0),ended_at:stamp(12),last_heartbeat_at:stamp(11)},[...events,{type:'job.state',payload:{state:'completed'},created_at:stamp(12)}],stamp(50));assert.equal(finished.active_ms,7000);assert.equal(finished.wall_ms,12000);assert.equal(finished.unconfirmed_ms,0);
});
test('historical orchestration heartbeat gaps do not become confirmed active after recovery',()=>{
 const events=[{type:'job.state',payload:{state:'running'},created_at:stamp(2)},{type:'job.uncertainty',payload:{since:stamp(3).toISOString(),until:stamp(8).toISOString()},created_at:stamp(8)},{type:'job.state',payload:{state:'completed'},created_at:stamp(10)}];const timing=jobTiming({created_at:stamp(0),ended_at:stamp(10)},events,stamp(20));assert.equal(timing.active_ms,3000);assert.equal(timing.unconfirmed_ms,5000);assert.equal(timing.wall_ms,10000);
});
