import assert from 'node:assert/strict';
import test from 'node:test';
import { monitorGuacamoleFixture } from './fixture-client.js';
test('official Guacamole fixture parser ACKs fragmented sync instead of relying on idle termination',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const stream=new ReadableStream<Uint8Array>({start(value){controller=value;}}),sent:string[]=[];
  const monitor=monitorGuacamoleFixture(stream.getReader(),async value=>{sent.push(value);});
  for(const value of ['4.si','ze,1.0,4.1024,3.768;4.sy','nc,3.123,1.0;'])controller.enqueue(new TextEncoder().encode(value));
  await monitor.ready;
  // Drain is deterministic: the final stream close follows all parsed writes.
  controller.close();await monitor.done;
  assert.deepEqual(sent,['4.sync,3.123;']);assert.equal(monitor.state.acknowledgements,1);
  assert.equal(monitor.state.error,null);assert.equal(monitor.state.closed,true);
});
