import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
const installedAge=process.platform==='darwin'?'/opt/homebrew/bin/age':'/usr/bin/age';
import {collectBackup,projectUser,projectHashConfig,prepareRestore,summarize,readonlyFetch,encryptBackup,createEncryptedBackup,verifyEncryptedBackup,decodeRestoreArchive,verifyReceiptSummary,diagnostic,FIXED} from '../../scripts/gcp/identity-backup.mjs';
const marker='PRIVATE_MUST_NEVER_APPEAR';const uid='11111111-1111-4111-8111-111111111111';
test('backup recipient is the independent local recovery identity, not the GCP import identity',()=>{assert.equal(FIXED.recipient,'age1vqswennss56g49gd9jd84fpn7p8jz6au7y974y394agvk2mfdg5sgeyat4');assert.notEqual(FIXED.recipient,'age1h0ceynyz6d7yuq72th3st08q5xau2hu2mh0ke5t82q68d2ygzujse3f4ll');});
const config=()=>({name:`projects/${FIXED.project}/config`,client:{apiKey:marker},notification:{smtp:{password:marker}},signIn:{hashConfig:{algorithm:'SCRYPT',signerKey:Buffer.alloc(32,8).toString('base64'),saltSeparator:'AQ==',rounds:8,memoryCost:14}}});
const user=()=>({localId:uid,email:'fixture@example.invalid',emailVerified:true,createdAt:'1700000000000',validSince:'1700000000',passwordUpdatedAt:1700000000000,version:2,
 providerUserInfo:[{providerId:'google.com',rawId:'fixture-google',email:'fixture@example.invalid'}],passwordHash:Buffer.alloc(64,9).toString('base64'),salt:Buffer.alloc(16,3).toString('base64')});
function fixture({rows=[user()],mutateSecond,mutateConfig,fetchFailure}={}){const calls=[];let scans=0,configs=0;return {calls,fetchImpl:async(url,options)=>{calls.push({url:String(url),options});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);
 if(fetchFailure)return fetchFailure(url,options);if(url.pathname.endsWith('/config')){const c=config();if(++configs===2)mutateConfig?.(c);return Response.json(c);}
 const copy=structuredClone(rows);if(++scans===2)mutateSecond?.(copy);return Response.json({users:copy});}};}
test('two bounded GET scans preserve credential/security metadata and select only hash configuration',async()=>{const f=fixture();const b=await collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl});assert.equal(f.calls.length,4);assert.equal(b.users[0].uid,uid);assert.equal(b.users[0].validSince,'1700000000');assert.equal(b.users[0].passwordUpdatedAt,1700000000000);assert.equal(b.users[0].passwordVersion,2);assert.equal(b.guarantees.atomicSnapshot,false);assert.doesNotMatch(JSON.stringify(b),new RegExp(marker));assert.equal(summarize(b).scryptPasswords,1);});
test('config and account GETs pin the quota project with no caller override',async()=>{
 const f=fixture();await collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl,quotaProject:'foreign-project'});
 assert.equal(f.calls.length,4);assert.equal(f.calls.filter(c=>new URL(c.url).pathname.endsWith('/config')).length,2);
 assert.equal(f.calls.filter(c=>new URL(c.url).pathname.endsWith('/accounts:batchGet')).length,2);
 for(const {options} of f.calls)assert.deepEqual(options.headers,{Authorization:'Bearer fixture-token','X-Goog-User-Project':'mfmf-499612'});
});
test('mixed unavailable BCRYPT and SCRYPT export never invents missing hash and restore batches are split',async()=>{const bcrypt={...user(),localId:'22222222-2222-4222-8222-222222222222',email:'second@example.invalid',passwordHash:'',salt:'',providerUserInfo:[{providerId:'google.com',rawId:'second-google'}]};const f=fixture({rows:[user(),bcrypt]});const b=await collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl});assert.equal(b.users[1].password.state,'unavailable');const r=prepareRestore(b);assert.equal(r.batches.length,2);assert.equal(r.batches[0].hashAlgorithm,'SCRYPT');assert.equal(r.batches[0].signerKey,b.hashConfig.signerKey);assert.ok(!Object.hasOwn(r.batches[0],'algorithm'));assert.ok(!Object.hasOwn(r.batches[1].users[0],'passwordHash'));assert.equal(r.passwordResetRequiredUids.length,1);assert.equal(r.revokeAfterRestoreUids.length,2);for(const batch of r.batches){assert.equal(batch.sanityCheck,true);assert.equal(batch.allowOverwrite,false);for(const u of batch.users)assert.ok(!Object.hasOwn(u,'validSince'));}});
const bcryptHash=()=>Buffer.from('$2b$10$'+'A'.repeat(53),'ascii').toString('base64');
test('REST-exported BCRYPT is preserved separately from SCRYPT without password reset',async()=>{
 const native={...user(),localId:'22222222-2222-4222-8222-222222222222',email:'bcrypt@example.invalid',passwordHash:bcryptHash(),salt:'',providerUserInfo:[{providerId:'google.com',rawId:'bcrypt-google'},{providerId:'password'}]};
 const b=await collectBackup({token:'fixture-token',fetchImpl:fixture({rows:[user(),native]}).fetchImpl});
 assert.deepEqual(b.users[1].password,{state:'bcrypt',hash:bcryptHash(),salt:'',resetRequired:false});
 const counts=summarize(b);assert.equal(counts.scryptPasswords,1);assert.equal(counts.bcryptPasswords,1);assert.equal(counts.passwordResetRequired,0);
 const restore=prepareRestore(b);assert.equal(restore.batches.length,2);const bcrypt=restore.batches.find(x=>x.hashAlgorithm==='BCRYPT');
 assert.deepEqual(Object.keys(bcrypt).sort(),['allowOverwrite','hashAlgorithm','sanityCheck','users']);
 assert.equal(bcrypt.users[0].passwordHash,bcryptHash());assert.ok(!Object.hasOwn(bcrypt.users[0],'salt'));
 assert.equal(restore.passwordResetRequiredUids.length,0);assert.equal(restore.revokeAfterRestoreUids.length,2);
 const cipher=fakeCipher(),verified=await decryptAndVerify(cipher,sha256(cipher),decryptFixture(JSON.stringify(b)));
 assert.equal(verified.bcryptPasswords,1);assert.equal(verified.scryptPasswords,1);assert.equal(verified.passwordResetRequired,0);assert.equal(verified.restoreBatches,2);
 assert.doesNotMatch(JSON.stringify(verified),/bcrypt@example|bcrypt-google|passwordHash|signerKey/);
});
for(const prefix of ['$2a$04$','$2b$10$','$2y$31$'])test('self-describing BCRYPT variant and supported cost accepted',()=>{
 const row={...user(),passwordHash:Buffer.from(prefix+'A'.repeat(53),'ascii').toString('base64'),salt:''};assert.equal(projectUser(row).password.state,'bcrypt');
});
for(const [hash,salt] of [
 [Buffer.from('$2b$03$'+'A'.repeat(53)).toString('base64'),''],[Buffer.from('$2b$32$'+'A'.repeat(53)).toString('base64'),''],
 [Buffer.from('$2x$10$'+'A'.repeat(53)).toString('base64'),''],[Buffer.from('$2b$10$'+'A'.repeat(52)).toString('base64'),''],
 [Buffer.from('$2b$10$'+'A'.repeat(52)+'!').toString('base64'),''],[bcryptHash(),'AQ=='],[bcryptHash(),undefined],
 [Buffer.alloc(64,9).toString('base64'),''],[Buffer.from('unknown-hash').toString('base64'),''],
 [Buffer.concat([Buffer.from('$2b$10$'+'A'.repeat(52)),Buffer.from([0xc1])]).toString('base64'),''],
])test('unknown or inconsistent hash with empty salt is never labeled BCRYPT or SCRYPT',()=>{assert.throws(()=>projectUser({...user(),passwordHash:hash,salt}));});
test('restore rejects BCRYPT relabeling or altered reset and salt metadata',async()=>{
 const b=await collectBackup({token:'fixture-token',fetchImpl:fixture({rows:[{...user(),passwordHash:bcryptHash(),salt:''}]}).fetchImpl});
 for(const change of [x=>x.users[0].password.state='scrypt',x=>x.users[0].password.resetRequired=true,x=>x.users[0].password.salt='AQ==',x=>x.users[0].password.hash=Buffer.alloc(64,9).toString('base64')]){const value=structuredClone(b);change(value);assert.throws(()=>prepareRestore(value));}
});
test('SCRYPT and provider-only REST batches contain only the exact allowed keys',async()=>{
 const absent={...user(),localId:'22222222-2222-4222-8222-222222222222',email:'no-password@example.invalid',providerUserInfo:[{providerId:'google.com',rawId:'no-password-google'}]};
 delete absent.passwordHash;delete absent.salt;delete absent.passwordUpdatedAt;delete absent.version;
 const b=await collectBackup({token:'fixture-token',fetchImpl:fixture({rows:[user(),absent]}).fetchImpl});
 const restore=prepareRestore(b);assert.equal(restore.batches.length,2);
 for(const batch of restore.batches){assert.deepEqual(Object.keys(batch).sort(),['allowOverwrite','hashAlgorithm','memoryCost','rounds','saltSeparator','sanityCheck','signerKey','users']);assert.equal(batch.hashAlgorithm,'SCRYPT');}
 assert.ok(!Object.hasOwn(restore.batches[1].users[0],'passwordHash'));
});
test('finalized receipt compares BCRYPT count and rejects missing or altered values',async()=>{
 const b=await collectBackup({token:'fixture-token',fetchImpl:fixture({rows:[{...user(),passwordHash:bcryptHash(),salt:''}]}).fetchImpl});
 const summary=summarize(b);assert.equal(summary.bcryptPasswords,1);assert.doesNotThrow(()=>verifyReceiptSummary(summary,summary));
 for(const change of [x=>delete x.bcryptPasswords,x=>x.bcryptPasswords=0,x=>x.bcryptPasswords=2,x=>x.bcryptPasswords='1']){const receipt={...summary};change(receipt);assert.throws(()=>verifyReceiptSummary(receipt,summary),e=>diagnostic(e).stage==='verify');}
 const missing={...summary};delete missing.bcryptPasswords;assert.throws(()=>verifyReceiptSummary(missing,missing));
});
test('no-password Google user is distinguished from empty exported hash',()=>{const u=user();delete u.passwordHash;delete u.salt;delete u.passwordUpdatedAt;delete u.version;assert.equal(projectUser(u).password.state,'none');u.providerUserInfo.push({providerId:'password'});assert.equal(projectUser(u).password.state,'unavailable');});
test('disabled and consent evidence are preserved without privilege inference',()=>{const u=user();u.disabled=true;u.customAttributes=JSON.stringify({tos_accepted_at:'2026-10-01T00:00:00Z'});const p=projectUser(u);assert.equal(p.disabled,true);assert.equal(p.customClaims.tos_accepted_at,'2026-10-01T00:00:00Z');});
test('future opaque IdP UID and original recovery email remain explicit evidence',()=>{const u=user();u.localId='opaque_Identity-123';u.initialEmail='original@example.invalid';const p=projectUser(u);assert.equal(p.uid,u.localId);assert.equal(p.initialEmail,u.initialEmail);});
for(const [label,change] of [['redacted hash',u=>u.passwordHash=Buffer.from('REDACTED').toString('base64')],['redacted salt',u=>u.salt=Buffer.from('REDACTED').toString('base64')],['MFA',u=>u.mfaInfo=[{phoneInfo:marker}]],['tenant',u=>u.tenantId=marker],['raw password',u=>u.rawPassword=marker],['phone',u=>u.phoneNumber=marker],['unsupported provider',u=>u.providerUserInfo[0].providerId=marker],['invalid claims',u=>u.customAttributes=marker],['invalid salt',u=>u.salt=marker],['wrong bool',u=>u.disabled=marker]])test(`rejects ${label} without private errors`,()=>{const u=user();change(u);assert.throws(()=>projectUser(u),e=>{assert.doesNotMatch(String(e),new RegExp(marker));assert.doesNotMatch(JSON.stringify(diagnostic(e)),new RegExp(marker));return true;});});
for(const [label,change]of [['missing key',c=>delete c.signIn.hashConfig.signerKey],['wrong algorithm',c=>c.signIn.hashConfig.algorithm='BCRYPT'],['foreign project',c=>c.name='projects/foreign/config'],['missing parameters',c=>delete c.signIn.hashConfig.rounds],['redacted key',c=>c.signIn.hashConfig.signerKey=Buffer.from('REDACTED').toString('base64')]])test(`configuration fails closed: ${label}`,()=>{const c=config();change(c);assert.throws(()=>projectHashConfig(c));});
for(const [label,change]of [['password',u=>u.passwordHash=Buffer.alloc(64,1).toString('base64')],['disabled',u=>u.disabled=true],['revocation',u=>u.validSince='1700000001'],['provider',u=>u.providerUserInfo[0].rawId='changed'],['email',u=>u.email='changed@example.invalid']])test(`two-pass ${label} drift rejects archive`,async()=>{const f=fixture({mutateSecond:rows=>change(rows[0])});await assert.rejects(collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl}),e=>diagnostic(e).stage==='consistency');});
test('hash configuration drift fails closed',async()=>{const f=fixture({mutateConfig:c=>c.signIn.hashConfig.rounds=9});await assert.rejects(collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl}));});
test('duplicate uid, email or Google subject fails closed',async()=>{for(const changed of [{},{localId:'22222222-2222-4222-8222-222222222222'},{localId:'22222222-2222-4222-8222-222222222222',email:'other@example.invalid'}]){const f=fixture({rows:[user(),{...user(),...changed}]});await assert.rejects(collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl}));}});
test('pagination repeats fail rather than loop indefinitely',async()=>{let calls=0;await assert.rejects(collectBackup({token:'fixture-token',fetchImpl:async url=>{calls++;return url.pathname.endsWith('/config')?Response.json(config()):Response.json({users:[],nextPageToken:'fixed'});}}));assert.equal(calls,3);});
test('pagination follows only bounded token on fixed account endpoint',async()=>{let n=0;const calls=[];const b=await collectBackup({token:'fixture-token',fetchImpl:async url=>{calls.push(String(url));if(url.pathname.endsWith('/config'))return Response.json(config());n++;return n%2?Response.json({users:[],nextPageToken:'https://foreign.invalid/?PRIVATE'}):Response.json({users:[user()]});}});assert.equal(b.users.length,1);assert.ok(calls.every(u=>new URL(u).origin==='https://identitytoolkit.googleapis.com'));});
test('network, HTTP and JSON errors never expose body',async()=>{for(const fetchFailure of [()=>{throw Error(marker);},()=>new Response(marker,{status:403}),()=>new Response(marker)]){const f=fixture({fetchFailure});await assert.rejects(collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl}),e=>{assert.doesNotMatch(String(e)+JSON.stringify(diagnostic(e)),new RegExp(marker));return true;});}});
test('GET-only wrapper refuses foreign destination and every mutation',async()=>{let called=0;const get=readonlyFetch(async()=>{called++;return Response.json({});});for(const [url,options]of [['https://evil.invalid',{}],[`https://identitytoolkit.googleapis.com/v1/projects/${FIXED.project}/accounts:batchCreate`,{method:'POST'}],[`https://identitytoolkit.googleapis.com/v1/projects/${FIXED.project}/accounts:batchGet?maxResults=1000`,{method:'GET',body:'PRIVATE'}]])await assert.rejects(get(url,{redirect:'error',...options}));assert.equal(called,0);});
test('plaintext reaches only age stdin, child argv/environment carry no user/hash/token',async()=>{const f=fixture(),b=await collectBackup({token:'PRIVATE_TOKEN',fetchImpl:f.fetchImpl});let captured;const ciphertext=await encryptBackup(b,{spawnImpl:(exe,args,opts)=>{assert.equal(exe,'/usr/bin/age');assert.doesNotMatch(JSON.stringify({args,opts}),/fixture@example|PRIVATE_TOKEN|signerKey/);const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.kill=()=>{};const parts=[];c.stdin.on('data',p=>parts.push(Buffer.from(p)));c.stdin.on('finish',()=>{captured=JSON.parse(Buffer.concat(parts));c.stdout.end('age-encryption.org/v1\nFAKE_ENCRYPTED');queueMicrotask(()=>c.emit('close',0));});return c;}});assert.equal(captured.users[0].uid,uid);assert.match(ciphertext.toString(),/^age-encryption/);});
test('encryption child failure never yields a backup',async()=>{await assert.rejects(encryptBackup(await collectBackup({token:'fixture-token',fetchImpl:fixture().fetchImpl}),{spawnImpl:()=>{const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.kill=()=>{};queueMicrotask(()=>c.emit('close',1));return c;}}));});
test('encryption launch failure is sanitized',async()=>{await assert.rejects(encryptBackup(await collectBackup({token:'fixture-token',fetchImpl:fixture().fetchImpl}),{spawnImpl:()=>{throw Error(marker);}}),e=>{assert.doesNotMatch(String(e),new RegExp(marker));return true;});});
test('installed age encrypts synthetic backup entirely in memory with no plaintext ciphertext marker',{skip:!existsSync(installedAge)},async()=>{const f=fixture(),b=await collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl});const cipher=await encryptBackup(b,{agePath:installedAge});assert.ok(cipher.length>200);assert.ok(!cipher.includes(Buffer.from('fixture@example.invalid')));assert.ok(!cipher.includes(Buffer.from('signerKey')));cipher.fill(0);});
test('restore preparation rejects altered hashes, unsupported accounts or hidden reset flags',async()=>{const f=fixture(),b=await collectBackup({token:'fixture-token',fetchImpl:f.fetchImpl});for(const change of [x=>x.users[0].uid='../PRIVATE',x=>x.hashConfig.algorithm='BCRYPT',x=>x.users[0].password.resetRequired=true,x=>x.users[0].providers.push({providerId:'foreign'}),x=>x.users[0].password.hash='invalid']){const c=structuredClone(b);change(c);assert.throws(()=>prepareRestore(c));}});
const fakeCipher=()=>Buffer.from('age-encryption.org/v1\nSYNTHETIC_CIPHERTEXT');
const sha256=b=>createHash('sha256').update(b).digest('hex');
function receiptFor(backup,cipher=fakeCipher()) { return {format:'mfmf-idp-backup-receipt-v1',status:'encrypted',projectId:FIXED.project,projectNumber:FIXED.number,archive:FIXED.archive,
 createdAt:backup.completedAt,sourceStartedAt:backup.startedAt,sourceCompletedAt:backup.completedAt,ciphertextSha256:sha256(cipher),ciphertextBytes:cipher.length,
 recipientSha256:sha256(FIXED.recipient),...summarize(backup),plaintextPersisted:false,restoreVerified:false}; }
function decryptFixture(payload,{code=0,receipt}={}){let calls=0;let backup;try{backup=JSON.parse(payload);}catch{}
 return {get calls(){return calls;},receipt:receipt??(backup?.users?receiptFor(backup):{ciphertextSha256:sha256(fakeCipher()),ciphertextBytes:fakeCipher().length,recipientSha256:sha256(FIXED.recipient)}),
 decryptImpl:async ciphertext=>{calls++;assert.deepEqual(ciphertext,fakeCipher());if(code)throw Error(marker);return Buffer.from(payload);}};}
const decryptAndVerify=verifyEncryptedBackup;
test('decrypt verification uses only fixed age identity and returns no plaintext or users',async()=>{
 const b=await collectBackup({token:'PRIVATE_TOKEN',fetchImpl:fixture().fetchImpl});const f=decryptFixture(JSON.stringify(b)),cipher=fakeCipher();
 const result=await decryptAndVerify(cipher,sha256(cipher),f);assert.equal(f.calls,1);assert.equal(result.status,'verified');assert.equal(result.users,1);
 assert.equal(result.revokeAfterRestore,1);assert.equal(result.restoreBatches,1);assert.equal(result.networkRequests,0);assert.equal(result.cloudMutations,0);
 assert.equal(result.plaintextPersisted,false);assert.equal(result.ciphertextSha256,sha256(cipher));
 assert.doesNotMatch(JSON.stringify(result),/fixture@example|fixture-google|signerKey|PRIVATE_TOKEN|11111111/);
});
test('ciphertext digest, header and size are checked before age launch',async()=>{
 const f=decryptFixture('{}');for(const [cipher,sha]of [[fakeCipher(),'0'.repeat(64)],[Buffer.from(marker),sha256(Buffer.from(marker))],[Buffer.alloc(16*1024*1024+65537),'0'.repeat(64)]])
 await assert.rejects(decryptAndVerify(cipher,sha,f),e=>diagnostic(e).stage==='verify');assert.equal(f.calls,0);
});
test('decryption errors, invalid UTF8/JSON and excessive plaintext never return private details',async()=>{
 for(const [payload,code]of [[marker,1],[marker,0],[Buffer.from([0xff,0xfe]),0],[Buffer.alloc(16*1024*1024+1,65),0]]){
  const f=decryptFixture(payload,{code}),cipher=fakeCipher();await assert.rejects(decryptAndVerify(cipher,sha256(cipher),f),e=>!JSON.stringify(diagnostic(e)).includes(marker)&&!String(e).includes(marker));
 }
 const cipher=fakeCipher();await assert.rejects(decryptAndVerify(cipher,sha256(cipher),{...decryptFixture('{}'),decryptImpl:()=>{throw Error(marker);}}),e=>diagnostic(e).stage==='decrypt');
});
test('verification rejects false envelope guarantees and corrupt restore data',async()=>{
 const b=await collectBackup({token:'fixture-token',fetchImpl:fixture().fetchImpl});for(const change of [x=>x.guarantees.twoPassEqual=false,x=>x.guarantees.atomicSnapshot=true,
  x=>x.source.projectId='foreign',x=>x.unexpected=marker,x=>x.completedAt='invalid',x=>x.startedAt='9999-01-01T00:00:00Z',
  x=>x.users[0].password.resetRequired=true,x=>x.hashConfig.signerKey='invalid']){
  const changed=structuredClone(b);change(changed);const f=decryptFixture(JSON.stringify(changed)),cipher=fakeCipher();
  await assert.rejects(decryptAndVerify(cipher,sha256(cipher),f),e=>['verify','archive'].includes(diagnostic(e).stage));
 }
});

function encryptionFixture({failure,signal}={}){
 let calls=0,kills=0,plaintext;
 return {get calls(){return calls;},get kills(){return kills;},get plaintext(){return plaintext;},spawnImpl:(exe,args,options)=>{
  calls++;assert.equal(exe,'/usr/bin/age');assert.deepEqual(args,['--encrypt','--recipient',FIXED.recipient]);
  assert.deepEqual(options,{stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{kills++;};
  const parts=[];child.stdin.on('data',part=>parts.push(Buffer.from(part)));child.stdin.on('finish',()=>{
   plaintext=Buffer.concat(parts);for(const part of parts)part.fill(0);
   if(failure==='abort'){signal.abort();return;}
   if(failure==='hang')return;
   if(failure==='stderr'){child.emit('error',Error(marker));return;}
   child.stdout.end(failure==='oversized'?Buffer.alloc(16*1024*1024+65537):failure==='header'?'INVALID_HEADER':fakeCipher());
   queueMicrotask(()=>child.emit('close',failure==='exit'?1:0));
  });return child;
 }};
}
test('encrypted export returns only ciphertext and a complete safe receipt',async()=>{
 const f=fixture(),age=encryptionFixture(),time='2026-10-29T00:00:00.123Z';
 const out=await createEncryptedBackup({token:marker,recipient:FIXED.recipient,fetchImpl:f.fetchImpl,spawnImpl:age.spawnImpl,now:()=>time});
 assert.equal(age.calls,1);assert.equal(f.calls.length,4);assert.deepEqual(Object.keys(out).sort(),['ciphertext','receipt']);
 assert.deepEqual(out.receipt,receiptFor(JSON.parse(age.plaintext),out.ciphertext));
 assert.deepEqual(Object.keys(out.receipt).sort(),['format','status','projectId','projectNumber','archive','createdAt','sourceStartedAt','sourceCompletedAt','ciphertextSha256','ciphertextBytes','recipientSha256','users','googleLinked','scryptPasswords','bcryptPasswords','passwordResetRequired','noPassword','disabled','twoPassEqual','atomicSnapshot','cloudMutations','plaintextPersisted','restoreVerified'].sort());
 assert.doesNotMatch(JSON.stringify(out.receipt),/fixture@example|fixture-google|signerKey|passwordHash|PRIVATE|11111111/);
 assert.equal(out.receipt.restoreVerified,false);assert.equal(out.receipt.plaintextPersisted,false);
 const verified=await verifyEncryptedBackup(out.ciphertext,out.receipt.ciphertextSha256,{receipt:out.receipt,decryptImpl:async()=>Buffer.from(age.plaintext)});
 assert.equal(verified.verification,'decrypt-and-restore-plan');assert.equal(verified.actualAccountRestoreVerified,false);assert.equal(verified.users,1);
 age.plaintext.fill(0);
});
test('recipient mismatch stops before account/config access or age launch',async()=>{
 for(const recipient of [undefined,'age1invalid','age1h0ceynyz6d7yuq72th3st08q5xau2hu2mh0ke5t82q68d2ygzujse3f4ll']){
  const f=fixture(),age=encryptionFixture();await assert.rejects(createEncryptedBackup({token:'fixture',recipient,fetchImpl:f.fetchImpl,spawnImpl:age.spawnImpl}));
  assert.equal(f.calls.length,0);assert.equal(age.calls,0);
 }
});
for(const failure of ['exit','stderr','header','oversized'])test(`age ${failure} never publishes an encrypted result`,async()=>{
 const f=fixture(),age=encryptionFixture({failure});await assert.rejects(createEncryptedBackup({token:'fixture',recipient:FIXED.recipient,fetchImpl:f.fetchImpl,spawnImpl:age.spawnImpl}),e=>diagnostic(e).stage==='encrypt'&&!String(e).includes(marker));
 age.plaintext?.fill(0);
});
test('abort terminates encryption and pre-aborted collection performs zero GETs',async()=>{
 const controller=new AbortController(),f=fixture(),age=encryptionFixture({failure:'abort',signal:controller});
 await assert.rejects(createEncryptedBackup({token:'fixture',recipient:FIXED.recipient,fetchImpl:f.fetchImpl,spawnImpl:age.spawnImpl,signal:controller.signal}));
 assert.equal(age.kills,1);age.plaintext.fill(0);
 const next=fixture();await assert.rejects(collectBackup({token:'fixture',fetchImpl:next.fetchImpl,signal:controller.signal}));assert.equal(next.calls.length,0);
});
test('short caller timeout kills a hung age process without exposing child data',async()=>{
 const f=fixture(),age=encryptionFixture({failure:'hang'});const keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(createEncryptedBackup({token:'fixture',recipient:FIXED.recipient,fetchImpl:f.fetchImpl,spawnImpl:age.spawnImpl,signal:AbortSignal.timeout(15)}));assert.equal(age.kills,1);}
 finally{clearTimeout(keepAlive);age.plaintext?.fill(0);}
});
test('offline sensitive restore API zeros decrypted Buffer and keeps all required restore gates',async()=>{
 const b=await collectBackup({token:'fixture',fetchImpl:fixture().fetchImpl}),bytes=Buffer.from(JSON.stringify(b)),cipher=fakeCipher();
 const decoded=await decodeRestoreArchive(cipher,sha256(cipher),{receipt:receiptFor(b),decryptImpl:async()=>bytes});
 assert.ok(bytes.every(byte=>byte===0));assert.equal(decoded.backup.users[0].uid,uid);
 assert.equal(decoded.restore.targetMustBeEmpty,true);assert.equal(decoded.restore.readbackRequired,true);assert.equal(decoded.restore.automaticRestoreAllowed,false);
 assert.deepEqual(decoded.restore.revokeAfterRestoreUids,[uid]);assert.ok(!Object.hasOwn(decoded.restore.batches[0].users[0],'validSince'));
});
test('wrong ciphertext digest or receipt pin stops before injected decrypt',async()=>{
 const b=await collectBackup({token:'fixture',fetchImpl:fixture().fetchImpl}),cipher=fakeCipher(),receipt=receiptFor(b);let calls=0;
 for(const mutate of [x=>x.ciphertextSha256='0'.repeat(64),x=>x.ciphertextBytes++,x=>x.recipientSha256='0'.repeat(64)]){
  const r=structuredClone(receipt);mutate(r);await assert.rejects(decodeRestoreArchive(cipher,sha256(cipher),{receipt:r,decryptImpl:()=>{calls++;throw Error(marker);}}));
 }assert.equal(calls,0);
});
test('receipt counts, source times, destination, guarantees and extra keys must match after decrypt',async()=>{
 const b=await collectBackup({token:'fixture',fetchImpl:fixture().fetchImpl}),cipher=fakeCipher();
 for(const mutate of [x=>x.users++,x=>delete x.bcryptPasswords,x=>x.archive='../other',x=>x.sourceStartedAt='2020-01-01T00:00:00Z',x=>x.sourceCompletedAt='2020-01-01T00:00:00Z',x=>x.createdAt='2026-02-30T00:00:00Z',x=>x.restoreVerified=true,x=>x.atomicSnapshot=true,x=>x.projectId='foreign',x=>x.private=marker]){
  const receipt=receiptFor(b);mutate(receipt);const bytes=Buffer.from(JSON.stringify(b));
  await assert.rejects(verifyEncryptedBackup(cipher,sha256(cipher),{receipt,decryptImpl:async()=>bytes}),e=>!String(e).includes(marker));assert.ok(bytes.every(x=>x===0));
 }
});
test('archive envelope timestamps and unknown fields fail before age launch',async()=>{
 const b=await collectBackup({token:'fixture',fetchImpl:fixture().fetchImpl});
 for(const mutate of [x=>x.startedAt='2026-02-30T00:00:00Z',x=>x.completedAt='1900-01-01T00:00:00Z',x=>x.extra=marker,x=>x.guarantees.atomicSnapshot=true]){
  const value=structuredClone(b);mutate(value);const age=encryptionFixture();await assert.rejects(encryptBackup(value,{spawnImpl:age.spawnImpl}));assert.equal(age.calls,0);
 }
});
test('invalid collection clock is rejected before GET and later backward clock is rejected',async()=>{
 const f=fixture();await assert.rejects(collectBackup({token:'fixture',fetchImpl:f.fetchImpl,now:()=> '2026-02-30T00:00:00Z'}));assert.equal(f.calls.length,0);
 let n=0;await assert.rejects(collectBackup({token:'fixture',fetchImpl:fixture().fetchImpl,now:()=>++n===1?'2026-10-29T00:00:00Z':'2026-10-28T00:00:00Z'}));
});
test('HTTP status is the only provider error detail exposed, including cancellation failure',async()=>{
 for(const fetchFailure of [()=>new Response(marker,{status:403}),()=>({ok:false,status:403,body:{cancel:async()=>{throw Error(marker);}}})]){
  await assert.rejects(collectBackup({token:'fixture',fetchImpl:fixture({fetchFailure}).fetchImpl}),e=>{assert.deepEqual(diagnostic(e),{status:'failed',stage:'configuration',httpStatus:403,detailsWithheld:true});return true;});
 }
});
test('unsupported token shape and more than 1000 accounts fail closed',async()=>{
 for(const nextPageToken of [null,0,false,{},[]])await assert.rejects(collectBackup({token:'fixture',fetchImpl:async url=>url.pathname.endsWith('/config')?Response.json(config()):Response.json({users:[user()],nextPageToken})}));
 const rows=Array.from({length:1001},(_,i)=>({...user(),localId:`fixture-${i}`,email:`fixture${i}@example.invalid`,providerUserInfo:[{providerId:'google.com',rawId:`google${i}`}]}));
 await assert.rejects(collectBackup({token:'fixture',fetchImpl:fixture({rows}).fetchImpl}));
});

test('unknown current or future credential fields are never silently discarded',()=>{
 for(const change of [u=>u.passkeyInfo=[],u=>u.webAuthnCredentials=[{secret:marker}],u=>u.hashAlgorithm='PBKDF2_SHA256',u=>u.providerUserInfo[0].newCredential=marker]){
  const value=user();change(value);assert.throws(()=>projectUser(value),e=>diagnostic(e).stage==='unsupported-account'&&!String(e).includes(marker));
 }
});
test('known informational and volatile fields are explicitly excluded from credential backup',()=>{
 const value=user();value.language='ja';value.timeZone='Asia/Tokyo';value.dateOfBirth='2000-01-01';value.screenName='fixture';value.lastRefreshAt='2026-10-29T00:00:00.123456789Z';value.providerUserInfo[0].federatedId='https://accounts.google.com/fixture-google';
 const projected=projectUser(value);for(const key of ['language','timeZone','dateOfBirth','screenName','lastRefreshAt'])assert.ok(!Object.hasOwn(projected,key));assert.equal(projected.providers[0].rawId,'fixture-google');
});
