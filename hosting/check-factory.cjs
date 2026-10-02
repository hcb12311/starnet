'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { recordedGenerate } = require('../sidecar/slopcannon-provider.js');
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slopcannon-codex-isolated-'));
  let starts = 0;
  const createProvider = async () => { starts++; return { async *stream(request) {
    assert.equal(request.reasoningEffort, 'medium');
    assert.deepEqual(request.tools, []);
    assert.equal(request.model, 'isolated-model');
    yield { type: 'text', delta: '{"headline":"A product","description":"An accurate description.","caption":"The caption."}' };
    yield { type: 'usage', usage: { total_tokens: 42, prompt_tokens: 20, completion_tokens: 22, cost: 0 } };
    yield { type: 'done', finishReason: 'stop', truncated: false };
  } }; };
  const body = { job_id: '11111111-1111-1111-1111-111111111111', kind: 'copy', spec: { brand: 'Proof', brief: 'Check supplier files.' } };
  const options = { directory, body, createProvider, model: 'isolated-model' };
  try {
    const [a,b] = await Promise.all([recordedGenerate(options),recordedGenerate(options)]);
    assert.equal(starts, 1); assert.deepEqual(a,b); assert.equal(a.provider,'openai-codex');
    assert.equal(a.api_key_spend_usd,0);
    const recovered = await recordedGenerate({...options,body:{kind:'copy',spec:{brief:'Check supplier files.',brand:'Proof'},job_id:body.job_id}});
    assert.equal(recovered.reused,true); assert.equal(starts,1);
    await assert.rejects(() => recordedGenerate({...options,body:{...body,spec:{brand:'Changed'}}}), /factory_provider_input_conflict/);
    assert.equal(starts,1);
    const file = path.join(directory,'.secrets','slopcannon-provider',body.job_id,'copy.json');
    assert.equal((await fs.stat(file)).mode & 0o777,0o600);
    const overflowBody = { ...body, job_id:'22222222-2222-2222-2222-222222222222' };
    await assert.rejects(() => recordedGenerate({ ...options, body:overflowBody,
      createProvider: async () => ({ async *stream() {
        yield { type:'text', delta:'x'.repeat(65537) };
      } }) }), /factory_codex_output_limit/);
    await assert.rejects(() => fs.stat(path.join(directory,'.secrets','slopcannon-provider',overflowBody.job_id,'copy.json')), { code:'ENOENT' });
    console.log('PASS: subscription-only provider, bounded output, simultaneous replay, persisted recovery, input conflict and private checkpoint');
  } finally { await fs.rm(directory,{recursive:true}); }
})().catch(e => { console.error(e.message); process.exitCode=1; });
