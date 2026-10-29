// Identity Platform backup: production requests are fixed-project GET only.
// Plaintext account data and hash configuration are sensitive memory-only values.
// No import, account update, password reset or delete API exists in this module.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const FIXED = Object.freeze({
  project: "mfmf-499612", number: "92772745697",
  // Public recipient for the independently held recovery key. No private key is
  // required by scheduled exports, and no GCP-only import key is used here.
  recipient: "age1vqswennss56g49gd9jd84fpn7p8jz6au7y974y394agvk2mfdg5sgeyat4",
  archive: "identity-backup.json.age", receipt: "receipt.json", directory: "identity-backup-encrypted",
});
const ORIGIN='https://identitytoolkit.googleapis.com',CONFIG=`/admin/v2/projects/${FIXED.project}/config`,ACCOUNTS=`/v1/projects/${FIXED.project}/accounts:batchGet`;
const STAGES=new Set(['arguments','credentials','configuration','accounts','unsupported-account','redacted','consistency','encrypt','archive','decrypt','verify']);
const LIMIT=16*1024*1024,MAX_USERS=1000,MAX_PAGES=10,REDACTED=Buffer.from('REDACTED').toString('base64');
const BCRYPT=/^\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/;
// Known REST UserInfo / ProviderUserInfo fields. Unknown fields stop the backup:
// a newly introduced credential (for example a passkey) must not be discarded.
// Informational language/timeZone/dateOfBirth/screenName and volatile
// lastRefreshAt are intentionally omitted; session state is not restored.
// https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/UserInfo
const USER_FIELDS=new Set(['localId','email','displayName','language','photoUrl','timeZone','dateOfBirth','passwordHash','salt','version',
 'emailVerified','passwordUpdatedAt','providerUserInfo','validSince','disabled','lastLoginAt','createdAt','screenName','customAuth','rawPassword',
 'phoneNumber','customAttributes','emailLinkSignin','tenantId','mfaInfo','initialEmail','lastRefreshAt']);
const PROVIDER_FIELDS=new Set(['providerId','displayName','photoUrl','federatedId','email','rawId','screenName','phoneNumber']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
export class BackupError extends Error{constructor(stage,httpStatus){super('Identity backup stopped; details withheld.');this.stage=STAGES.has(stage)?stage:'arguments';
 if(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599)this.httpStatus=httpStatus;}}
const need=(v,stage)=>{if(!v)throw new BackupError(stage);};
export const diagnostic=e=>({status:'failed',stage:e instanceof BackupError&&STAGES.has(e.stage)?e.stage:'arguments',
 ...(e instanceof BackupError&&Number.isInteger(e.httpStatus)&&e.httpStatus>=100&&e.httpStatus<=599?{httpStatus:e.httpStatus}:{}),detailsWithheld:true});
function string(v,max=1024){need(typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v),'accounts');return v;}
function bool(v){need(v===undefined||typeof v==='boolean','accounts');return v??false;}
function numeric(v,stage='accounts'){need(typeof v==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(v)&&Number.isSafeInteger(Number(v)),stage);return v;}
function b64(v,stage){need(typeof v==='string'&&v.length>0&&v.length<=4096&&/^[A-Za-z0-9+/_-]+={0,2}$/.test(v),'redacted');const bytes=Buffer.from(v,'base64');
 need(bytes.length>0&&bytes.toString('base64').replace(/=+$/,'')===v.replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,''),stage);return v;}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(object(v))return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
export function projectHashConfig(response){
 try{need(object(response)&&[`projects/${FIXED.project}/config`,`projects/${FIXED.number}/config`].includes(response.name),'configuration');
 const c=response.signIn?.hashConfig;need(object(c)&&c.algorithm==='SCRYPT','configuration');
 need(Number.isInteger(c.rounds)&&c.rounds>=1&&c.rounds<=32&&Number.isInteger(c.memoryCost)&&c.memoryCost>=1&&c.memoryCost<=30,'configuration');
 need(c.signerKey!==REDACTED&&c.saltSeparator!==REDACTED,'redacted');
 return {algorithm:'SCRYPT',signerKey:b64(c.signerKey,'configuration'),saltSeparator:c.saltSeparator===''?'':b64(c.saltSeparator,'configuration'),rounds:c.rounds,memoryCost:c.memoryCost};
 }catch(e){throw e instanceof BackupError?e:new BackupError('configuration');}
}
export function projectUser(row){
 try{
  need(object(row)&&Object.keys(row).every(key=>USER_FIELDS.has(key))&&!row.tenantId&&!row.rawPassword&&!row.phoneNumber&&!row.customAuth&&!row.emailLinkSignin
   &&(row.mfaInfo===undefined||(Array.isArray(row.mfaInfo)&&row.mfaInfo.length===0)),'unsupported-account');
  // Initial imports use UUIDs; later IdP-created accounts may use opaque UIDs.
  // Preserve the UID exactly. Never reconstruct it from email or provider ID.
  const uid=string(row.localId,128);need(/^[A-Za-z0-9_-]{1,128}$/.test(uid),'unsupported-account');
  const email=string(row.email,255);need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'accounts');
  const user={uid,email,emailVerified:bool(row.emailVerified),disabled:bool(row.disabled),createdAt:numeric(row.createdAt),providers:[]};
  for(const key of ['displayName','photoUrl'])if(row[key]!==undefined)user[key]=string(row[key],2048);
  if(row.initialEmail!==undefined){user.initialEmail=string(row.initialEmail,255);need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.initialEmail),'accounts');}
  for(const key of ['lastLoginAt','validSince'])if(row[key]!==undefined)user[key]=numeric(row[key]);
  if(row.passwordUpdatedAt!==undefined){need(typeof row.passwordUpdatedAt==='number'&&Number.isFinite(row.passwordUpdatedAt)&&row.passwordUpdatedAt>=0&&row.passwordUpdatedAt<=Number.MAX_SAFE_INTEGER,'accounts');user.passwordUpdatedAt=row.passwordUpdatedAt;}
  if(row.version!==undefined){need(Number.isInteger(row.version)&&row.version>=0&&row.version<=2147483647,'accounts');user.passwordVersion=row.version;}
  if(row.customAttributes!==undefined){need(typeof row.customAttributes==='string'&&Buffer.byteLength(row.customAttributes)<=1000,'accounts');const claims=JSON.parse(row.customAttributes);need(object(claims),'accounts');user.customClaims=canonical(claims);}
  need(Array.isArray(row.providerUserInfo??[])&&(row.providerUserInfo??[]).length<=2,'unsupported-account');const seen=new Set();
  for(const p of row.providerUserInfo??[]){need(object(p)&&Object.keys(p).every(key=>PROVIDER_FIELDS.has(key))&&['google.com','password'].includes(p.providerId)&&!seen.has(p.providerId),'unsupported-account');seen.add(p.providerId);
   const provider={providerId:p.providerId};if(p.providerId==='google.com')provider.rawId=string(p.rawId,255);
   for(const key of ['email','displayName','photoUrl'])if(p[key]!==undefined)provider[key]=string(p[key],2048);
   user.providers.push(provider);
  }user.providers.sort((a,b)=>a.providerId.localeCompare(b.providerId));
  need(row.passwordHash!==REDACTED&&row.salt!==REDACTED,'redacted');
  if(typeof row.passwordHash==='string'&&row.passwordHash.length>0){
   const encoded=b64(row.passwordHash,'accounts'),bytes=Buffer.from(encoded,'base64');
   try{
    const bcrypt=bytes.length===60&&BCRYPT.test(bytes.toString('latin1'));
    // REST batchGet was observed returning the original, self-describing BCRYPT
    // hash with an explicitly empty salt after import. This is distinct from
    // Firebase CLI's documented empty legacy-hash export. Never infer BCRYPT
    // from salt alone or fall back to an older source archive's credential.
    if(bcrypt){need(row.salt==='','accounts');user.password={state:'bcrypt',hash:encoded,salt:'',resetRequired:false};}
    else{need(!bytes.toString('latin1').startsWith('$2'),'accounts');user.password={state:'scrypt',hash:encoded,salt:b64(row.salt,'accounts'),resetRequired:false};}
   }finally{bytes.fill(0);}
  }
  else{
   need(row.passwordHash===undefined||row.passwordHash===null||row.passwordHash==='','accounts');
   need(row.salt===undefined||row.salt===null||row.salt==='','accounts');
   const unavailable=row.passwordHash===''||seen.has('password')||(row.passwordUpdatedAt??0)>0;
   user.password={state:unavailable?'unavailable':'none',resetRequired:unavailable};
  }
  need(user.providers.some(p=>p.providerId==='google.com')||user.password.state!=='none','unsupported-account');return user;
 }catch(e){throw e instanceof BackupError?e:new BackupError('accounts');}
}
function validateUsers(users){const ids=new Set(),emails=new Set(),google=new Set();need(users.length>0&&users.length<=MAX_USERS,'accounts');
 for(const user of users){need(!ids.has(user.uid)&&!emails.has(user.email.toLowerCase()),'accounts');ids.add(user.uid);emails.add(user.email.toLowerCase());
  for(const p of user.providers.filter(p=>p.providerId==='google.com')){need(!google.has(p.rawId),'accounts');google.add(p.rawId);}}
 return users.sort((a,b)=>a.uid.localeCompare(b.uid));}
export function readonlyFetch(fetchImpl=fetch){return async(url,options={})=>{let parsed;try{parsed=new URL(url);}catch{throw new BackupError('arguments');}
 need(parsed.origin===ORIGIN&&!parsed.username&&!parsed.password&&!parsed.hash&&options.method==='GET'&&options.body===undefined&&options.redirect==='error','arguments');
 if(parsed.pathname===CONFIG)need(parsed.searchParams.size===1&&parsed.searchParams.get('fields')==='name,signIn(hashConfig)','arguments');
 else{need(parsed.pathname===ACCOUNTS&&parsed.searchParams.get('maxResults')==='1000'
  &&[...parsed.searchParams.keys()].every(k=>['maxResults','nextPageToken'].includes(k))
  &&parsed.searchParams.getAll('maxResults').length===1&&parsed.searchParams.getAll('nextPageToken').length<=1,'arguments');}
 return fetchImpl(parsed,options);};}
async function readJson(fetchImpl,url,token,stage,signal){let response;try{need(!signal.aborted,stage);
 response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,'X-Goog-User-Project':FIXED.project},redirect:'error',
  signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});}catch{throw new BackupError(stage);}
 if(!response.ok){try{await response.body?.cancel();}catch{/* Never expose cancellation failures. */}throw new BackupError(stage,response.status);}
 const chunks=[];let bytes,size=0;try{for await(const part of response.body){size+=part.length;need(size<=LIMIT,stage);chunks.push(Buffer.from(part));}
 bytes=Buffer.concat(chunks);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch{throw new BackupError(stage);}finally{bytes?.fill(0);for(const part of chunks)part.fill(0);}}
async function scan(fetchImpl,token,signal){const users=[],tokens=new Set();let cursor;
 for(let page=0;page<MAX_PAGES;page++){const url=new URL(ACCOUNTS,ORIGIN);url.searchParams.set('maxResults','1000');if(cursor)url.searchParams.set('nextPageToken',cursor);
 const value=await readJson(fetchImpl,url,token,'accounts',signal);need(object(value)&&Array.isArray(value.users??[]),'accounts');for(const row of value.users??[])users.push(projectUser(row));need(users.length<=MAX_USERS,'accounts');
 if(value.nextPageToken===undefined||value.nextPageToken==='')return validateUsers(users);
 cursor=string(value.nextPageToken,4096);need(!tokens.has(cursor),'accounts');tokens.add(cursor);
 }throw new BackupError('accounts');}
export async function collectBackup({token,fetchImpl=fetch,signal=AbortSignal.timeout(120000),now=()=>new Date().toISOString()}={}){
 need(typeof token==='string'&&token.length>0&&token.length<=16384&&!/[\s\x00-\x1f\x7f]/.test(token),'credentials');
 const request=readonlyFetch(fetchImpl),url=new URL(CONFIG,ORIGIN);url.searchParams.set('fields','name,signIn(hashConfig)');const startedAt=timestamp(now(),'arguments');
 const before=projectHashConfig(await readJson(request,url,token,'configuration',signal));
 const first=await scan(request,token,signal),second=await scan(request,token,signal);
 const after=projectHashConfig(await readJson(request,url,token,'configuration',signal));
 need(JSON.stringify(canonical(before))===JSON.stringify(canonical(after))&&JSON.stringify(canonical(first))===JSON.stringify(canonical(second)),'consistency');
 const result={format:'mfmf-idp-backup-v1',source:{projectId:FIXED.project,projectNumber:FIXED.number},startedAt,completedAt:timestamp(now(),'arguments'),hashConfig:before,users:first,
  guarantees:{...GUARANTEES}};
 need(Date.parse(result.startedAt)<=Date.parse(result.completedAt)&&Buffer.byteLength(JSON.stringify(result))<=LIMIT,'consistency');
 return result;
}
export function summarize(backup){return {users:backup.users.length,googleLinked:backup.users.filter(u=>u.providers.some(p=>p.providerId==='google.com')).length,
 scryptPasswords:backup.users.filter(u=>u.password.state==='scrypt').length,bcryptPasswords:backup.users.filter(u=>u.password.state==='bcrypt').length,passwordResetRequired:backup.users.filter(u=>u.password.resetRequired).length,
 noPassword:backup.users.filter(u=>u.password.state==='none').length,disabled:backup.users.filter(u=>u.disabled).length,twoPassEqual:true,atomicSnapshot:false,cloudMutations:0};}
// Pure restore preparation only. No API method can upload/delete/change users.
// validSince/passwordUpdatedAt remain audit evidence, not a claim that import
// restores revocation. A separate approved restore must revoke every UID after
// import and verify checkRevoked before opening the application.
export function prepareRestore(backup){
 need(backup?.format==='mfmf-idp-backup-v1'&&backup.source?.projectId===FIXED.project&&backup.source?.projectNumber===FIXED.number,'archive');
 need(Array.isArray(backup.users)&&backup.users.length>0&&backup.users.length<=MAX_USERS,'archive');
 let checkedUsers,checkedHash;try{
  checkedHash=projectHashConfig({name:`projects/${FIXED.project}/config`,signIn:{hashConfig:backup.hashConfig}});
  checkedUsers=validateUsers(backup.users.map(u=>{
   need(object(u)&&object(u.password)&&['scrypt','bcrypt','none','unavailable'].includes(u.password.state),'archive');
   const raw={localId:u.uid,email:u.email,emailVerified:u.emailVerified,disabled:u.disabled,createdAt:u.createdAt,providerUserInfo:u.providers};
   for(const key of ['displayName','photoUrl','initialEmail','lastLoginAt','validSince','passwordUpdatedAt'])if(u[key]!==undefined)raw[key]=u[key];
   if(u.passwordVersion!==undefined)raw.version=u.passwordVersion;
   if(u.customClaims!==undefined)raw.customAttributes=JSON.stringify(u.customClaims);
   if(['scrypt','bcrypt'].includes(u.password.state)){raw.passwordHash=u.password.hash;raw.salt=u.password.salt;}
   else if(u.password.state==='unavailable'){raw.passwordHash='';raw.salt='';}
   return projectUser(raw);
  }));
  need(JSON.stringify(canonical(checkedUsers))===JSON.stringify(canonical(backup.users))
   &&JSON.stringify(canonical(checkedHash))===JSON.stringify(canonical(backup.hashConfig)),'archive');
 }catch{throw new BackupError('archive');}
 const scrypt=[],bcrypt=[],noPassword=[],resetRequired=[];for(const u of backup.users){
 const record={localId:u.uid,email:u.email,emailVerified:u.emailVerified,disabled:u.disabled,createdAt:u.createdAt,
  providerUserInfo:u.providers.filter(p=>p.providerId!=='password').map(p=>({...p}))};
 for(const key of ['displayName','photoUrl','lastLoginAt'])if(u[key]!==undefined)record[key]=u[key];
 if(u.customClaims!==undefined)record.customAttributes=JSON.stringify(u.customClaims);
 if(u.password.state==='scrypt'){record.passwordHash=u.password.hash;record.salt=u.password.salt;scrypt.push(record);}
 else if(u.password.state==='bcrypt'){record.passwordHash=u.password.hash;bcrypt.push(record);}
 else{need(['none','unavailable'].includes(u.password.state),'archive');noPassword.push(record);if(u.password.resetRequired)resetRequired.push(u.uid);}
 }
 // Project only REST batchCreate fields: the export's `algorithm` is not
 // an API field and must never be copied into a restore request.
 const scryptOptions={hashAlgorithm:'SCRYPT',signerKey:checkedHash.signerKey,saltSeparator:checkedHash.saltSeparator,
  rounds:checkedHash.rounds,memoryCost:checkedHash.memoryCost};
 const batches=[];if(bcrypt.length)batches.push({hashAlgorithm:'BCRYPT',users:bcrypt,sanityCheck:true,allowOverwrite:false});
 if(scrypt.length)batches.push({...scryptOptions,users:scrypt,sanityCheck:true,allowOverwrite:false});
 // REST requires hashAlgorithm even for provider-only rows. Supplying the known
 // project SCRYPT config here does NOT supply/infer a hash for these users.
 if(noPassword.length)batches.push({...scryptOptions,users:noPassword,sanityCheck:true,allowOverwrite:false});
 return {batches,passwordResetRequiredUids:resetRequired,revokeAfterRestoreUids:backup.users.map(u=>u.uid),
  initialEmailReviewUids:backup.users.filter(u=>u.initialEmail&&u.initialEmail!==u.email).map(u=>u.uid),
  targetMustBeEmpty:true,readbackRequired:true,automaticRestoreAllowed:false};
}

const GUARANTEES = Object.freeze({twoPassEqual:true,atomicSnapshot:false,sessionTokensIncluded:false,
 projectConfigurationIncluded:false,restoreRequiresRevokeAll:true,oldPasswordFallbackAllowed:false});
const AGE_HEADER = Buffer.from('age-encryption.org/v1\n');
const exactKeys=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function timestamp(value,stage){
 need(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  &&Number.isFinite(Date.parse(value)),stage);
 const normalized=new Date(value).toISOString();
 need(normalized.replace(/\.000Z$/,'Z')===value.replace(/\.0{1,3}Z$/,'Z')
  || normalized===value.replace(/\.(\d{1,2})Z$/,(_,n)=>'.'+n.padEnd(3,'0')+'Z'),stage);
 return value;
}
function validateEnvelope(backup){
 need(exactKeys(backup,['format','source','startedAt','completedAt','hashConfig','users','guarantees'])
  &&exactKeys(backup.source,['projectId','projectNumber'])&&equal(backup.guarantees,GUARANTEES),'archive');
 timestamp(backup.startedAt,'archive');timestamp(backup.completedAt,'archive');
 need(Date.parse(backup.startedAt)<=Date.parse(backup.completedAt),'archive');
 return prepareRestore(backup);
}
function checkRecipient(value){need(value===FIXED.recipient,'arguments');}
function checkCipher(ciphertext,expectedSha){
 need(Buffer.isBuffer(ciphertext)&&ciphertext.length>AGE_HEADER.length&&ciphertext.length<=LIMIT+65536
  &&/^[a-f0-9]{64}$/.test(expectedSha??'')&&hash(ciphertext)===expectedSha
  &&ciphertext.subarray(0,AGE_HEADER.length).equals(AGE_HEADER),'verify');
}

/** Only public recipient/flags reach argv; plaintext goes to age stdin. */
export function encryptBackup(backup,{recipient=FIXED.recipient,agePath='/usr/bin/age',spawnImpl=spawn,
 signal=AbortSignal.timeout(30000)}={}){
 return new Promise((resolve,reject)=>{
  let bytes,child,settled=false,timer;const chunks=[];let length=0;
  const stop=()=>{try{child?.kill('SIGKILL');}catch{/* No child exception or stderr is surfaced. */}};
  const finish=(failed)=>{
   if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);bytes?.fill(0);
   if(failed){stop();for(const part of chunks)part.fill(0);reject(new BackupError('encrypt'));return;}
   const ciphertext=Buffer.concat(chunks);for(const part of chunks)part.fill(0);
   if(ciphertext.length<=AGE_HEADER.length||!ciphertext.subarray(0,AGE_HEADER.length).equals(AGE_HEADER)){
    ciphertext.fill(0);reject(new BackupError('encrypt'));return;
   }
   resolve(ciphertext);
  };
  const aborted=()=>finish(true);
  try{
   checkRecipient(recipient);need(typeof agePath==='string'&&/^\/[A-Za-z0-9_./-]{1,511}$/.test(agePath),'encrypt');
   need(!signal.aborted,'encrypt');validateEnvelope(backup);bytes=Buffer.from(JSON.stringify(backup));need(bytes.length<=LIMIT,'encrypt');
   child=spawnImpl(agePath,['--encrypt','--recipient',recipient],{stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});
   timer=setTimeout(aborted,30000);signal.addEventListener('abort',aborted,{once:true});
   child.on('error',aborted);child.stdin.on('error',aborted);child.stdout.on('error',aborted);
   child.stdout.on('data',part=>{if(settled)return;length+=part.length;if(length>LIMIT+65536)finish(true);else chunks.push(Buffer.from(part));});
   child.on('close',code=>finish(code!==0));child.stdin.end(bytes);
  }catch{finish(true);}
 });
}

function makeReceipt(backup,ciphertext,createdAt){
 return {format:'mfmf-idp-backup-receipt-v1',status:'encrypted',projectId:FIXED.project,projectNumber:FIXED.number,
  archive:FIXED.archive,createdAt:timestamp(createdAt,'archive'),sourceStartedAt:backup.startedAt,sourceCompletedAt:backup.completedAt,
  ciphertextSha256:hash(ciphertext),ciphertextBytes:ciphertext.length,recipientSha256:hash(FIXED.recipient),
  ...summarize(backup),plaintextPersisted:false,restoreVerified:false};
}

/** Sensitive API values stay in memory. Return only ciphertext and public counts. */
export async function createEncryptedBackup({token,recipient,fetchImpl=fetch,spawnImpl=spawn,agePath='/usr/bin/age',
 signal=AbortSignal.timeout(120000),now=()=>new Date().toISOString()}={}){
 let ciphertext;try{
  checkRecipient(recipient); // Refuse misdirected encryption before the first account GET.
  const backup=await collectBackup({token,fetchImpl,signal,now});
  validateEnvelope(backup);
  ciphertext=await encryptBackup(backup,{recipient,spawnImpl,agePath,signal});
  const receipt=makeReceipt(backup,ciphertext,now());
  need(Date.parse(receipt.createdAt)>=Date.parse(backup.completedAt),'archive');
  return {ciphertext,receipt};
 }catch(error){ciphertext?.fill(0);throw error instanceof BackupError?error:new BackupError('encrypt');}
}

export function verifyReceiptSummary(receipt,result){
 need(object(receipt)&&object(result),'verify');
 for(const key of ['users','googleLinked','scryptPasswords','bcryptPasswords','passwordResetRequired','noPassword','disabled','twoPassEqual','atomicSnapshot','cloudMutations'])
  need(Object.hasOwn(receipt,key)&&Object.hasOwn(result,key)&&receipt[key]===result[key],'verify');
}
function verifyReceipt(receipt,backup,ciphertext){
 need(object(receipt),'verify');timestamp(receipt.createdAt,'verify');
 need(Date.parse(receipt.createdAt)>=Date.parse(backup.completedAt),'verify');
 need(equal(receipt,makeReceipt(backup,ciphertext,receipt.createdAt)),'verify');
}

/**
 * Offline, sensitive-memory API for a separately reviewed isolated restore.
 * decryptImpl receives ciphertext only and returns a Buffer. It must not save
 * plaintext or expose keys/errors. This module never reads an identity file.
 * Callers must not log the returned backup/restore batches or raw exceptions.
 */
export async function decodeRestoreArchive(ciphertext,expectedSha,{decryptImpl,receipt}={}){
 let bytes;
 try{
  checkCipher(ciphertext,expectedSha);need(typeof decryptImpl==='function','decrypt');
  // Hash and bounded receipt are checked before invoking any decryption process.
  need(object(receipt)&&receipt.ciphertextSha256===expectedSha&&receipt.ciphertextBytes===ciphertext.length
   &&receipt.recipientSha256===hash(FIXED.recipient),'verify');
  try{bytes=await decryptImpl(ciphertext);}catch{throw new BackupError('decrypt');}
  need(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=LIMIT,'verify');
  const backup=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const restore=validateEnvelope(backup);verifyReceipt(receipt,backup,ciphertext);
  return {backup,restore};
 }catch(error){throw error instanceof BackupError?error:new BackupError('verify');}
 finally{if(Buffer.isBuffer(bytes))bytes.fill(0);}
}

/** Public verification result only; never returns accounts, keys or restore bodies. */
export async function verifyEncryptedBackup(ciphertext,expectedSha,options){
 const {backup,restore}=await decodeRestoreArchive(ciphertext,expectedSha,options);
 return {format:'mfmf-idp-backup-verification-v1',status:'verified',ciphertextSha256:hash(ciphertext),ciphertextBytes:ciphertext.length,
  ...summarize(backup),restoreBatches:restore.batches.length,revokeAfterRestore:restore.revokeAfterRestoreUids.length,
  initialEmailReviewRequired:restore.initialEmailReviewUids.length,plaintextPersisted:false,networkRequests:0,
  verification:'decrypt-and-restore-plan',actualAccountRestoreVerified:false};
}
