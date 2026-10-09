import 'dotenv/config';
import express, { Request, Response } from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 3000);
const BASE = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || `http://localhost:${PORT}`;
const APP_ID = process.env.META_APP_ID || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const REDIRECT_URI = process.env.META_REDIRECT_URI || `${BASE}/oauth/callback`;
const VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const DB_PATH = process.env.DB_PATH || './instagram.sqlite';
const MCP_AUTH_TOKEN = must('MCP_AUTH_TOKEN');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
}
function b64url(buf: Buffer) { return buf.toString('base64url'); }
function pkceVerifier() { return b64url(crypto.randomBytes(32)); }
function challenge(v: string) { return b64url(crypto.createHash('sha256').update(v).digest()); }
function authRow() { return db.prepare('SELECT * FROM tokens WHERE id=1').get() as any; }
function saveToken(accessToken: string, userId: string, expiresIn: number) {
  const now = Math.floor(Date.now()/1000);
  db.prepare(`INSERT INTO tokens(id,access_token,user_id,expires_at,created_at,updated_at)
    VALUES(1,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,user_id=excluded.user_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .run(accessToken, userId, now + expiresIn, now, now);
}
async function graph(path: string, init: RequestInit = {}) {
  const row = authRow();
  if (!row) throw new Error('Instagram is not connected. Open /oauth/start first.');
  const url = `https://graph.instagram.com/${VERSION}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${row.access_token}`);
  headers.set('Content-Type', 'application/json');
  const r = await fetch(url, {...init, headers});
  const body = await r.text();
  let data: any; try { data = JSON.parse(body); } catch { data = { raw: body }; }
  if (!r.ok) throw new Error(`Meta Graph API ${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function exchangeAndSave(shortToken: string) {
  const u = new URL(`https://graph.instagram.com/access_token`);
  u.searchParams.set('grant_type','ig_exchange_token');
  u.searchParams.set('client_secret',APP_SECRET);
  u.searchParams.set('access_token',shortToken);
  const r = await fetch(u);
  const d: any = await r.json();
  if (!r.ok || !d.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(d)}`);
  const me = await fetch(`https://graph.instagram.com/${VERSION}/me?fields=id,username&access_token=${encodeURIComponent(d.access_token)}`);
  const md: any = await me.json();
  if (!me.ok || !md.id) throw new Error(`Could not resolve Instagram user: ${JSON.stringify(md)}`);
  saveToken(d.access_token, md.id, Number(d.expires_in || 60*24*60*60));
}
async function refreshIfNeeded() {
  const row = authRow();
  if (!row) return;
  const now = Math.floor(Date.now()/1000);
  if (row.expires_at - now > 7*24*60*60) return;
  const u = new URL('https://graph.instagram.com/refresh_access_token');
  u.searchParams.set('grant_type','ig_refresh_token');
  u.searchParams.set('access_token',row.access_token);
  const r = await fetch(u);
  const d: any = await r.json();
  if (r.ok && d.access_token) saveToken(d.access_token, row.user_id, Number(d.expires_in || 60*24*60*60));
}

function makeMcp() {
  const m = new McpServer({ name: 'instagram-chatgpt-mcp', version: '0.1.0' });
  m.tool('connection_status', 'Show whether the Instagram account is connected.', {}, async () => {
    const row = authRow();
    return { content: [{ type:'text', text: row ? `Connected to Instagram user ${row.user_id}. Token expires ${new Date(row.expires_at*1000).toISOString()}.` : 'Not connected. Open /oauth/start.' }] };
  });
  m.tool('get_profile', 'Read the connected Instagram professional profile.', {}, async () => {
    await refreshIfNeeded();
    const d = await graph(`/me?fields=id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count`);
    return { content:[{type:'text',text:JSON.stringify(d,null,2)}] };
  });
  m.tool('list_media', 'List recent posts/reels from the connected Instagram professional account.', { limit:z.number().int().min(1).max(100).default(25) }, async ({limit}) => {
    await refreshIfNeeded();
    const d = await graph(`/me/media?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=${limit}`);
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('get_media', 'Read one Instagram post/reel by media ID.', { media_id:z.string() }, async ({media_id}) => {
    const d = await graph(`/${encodeURIComponent(media_id)}?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count`);
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('get_account_insights', 'Read available account-level Instagram insights.', { metric:z.string().optional(), period:z.string().optional() }, async ({metric,period}) => {
    const qs = new URLSearchParams(); if(metric) qs.set('metric',metric); if(period) qs.set('period',period);
    const d = await graph(`/me/insights?${qs.toString()}`);
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('get_media_insights', 'Read insights for an Instagram post/reel.', { media_id:z.string(), metric:z.string().optional() }, async ({media_id,metric}) => {
    const qs = metric ? `?metric=${encodeURIComponent(metric)}` : '';
    const d = await graph(`/${encodeURIComponent(media_id)}/insights${qs}`);
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('get_comments', 'Read comments on an Instagram media item.', { media_id:z.string(), limit:z.number().int().min(1).max(100).default(50) }, async ({media_id,limit}) => {
    const d = await graph(`/${encodeURIComponent(media_id)}/comments?fields=id,text,username,timestamp,like_count,replies&limit=${limit}`);
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('reply_to_comment', 'Reply to an Instagram comment.', { comment_id:z.string(), message:z.string().min(1).max(2200) }, async ({comment_id,message}) => {
    const d = await graph(`/${encodeURIComponent(comment_id)}/replies`, {method:'POST',body:JSON.stringify({message})});
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('hide_comment', 'Hide or unhide an Instagram comment.', { comment_id:z.string(), hide:z.boolean() }, async ({comment_id,hide}) => {
    const d = await graph(`/${encodeURIComponent(comment_id)}`, {method:'POST',body:JSON.stringify({hide})});
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('delete_comment', 'Delete an Instagram comment.', { comment_id:z.string() }, async ({comment_id}) => {
    const d = await graph(`/${encodeURIComponent(comment_id)}`, {method:'DELETE'});
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  m.tool('publish_image', 'Publish an Instagram image post. image_url must be public HTTPS.', { image_url:z.string().url(), caption:z.string().max(2200).optional() }, async ({image_url,caption}) => {
    const body:any={image_url}; if(caption) body.caption=caption;
    const c=await graph('/me/media',{method:'POST',body:JSON.stringify(body)}); const p=await graph('/me/media_publish',{method:'POST',body:JSON.stringify({creation_id:c.id})});
    return {content:[{type:'text',text:JSON.stringify({container:c,published:p},null,2)}]};
  });
  m.tool('publish_reel', 'Publish an Instagram Reel. video_url must be public HTTPS.', { video_url:z.string().url(), caption:z.string().max(2200).optional() }, async ({video_url,caption}) => {
    const body:any={video_url,media_type:'REELS'}; if(caption) body.caption=caption;
    const c=await graph('/me/media',{method:'POST',body:JSON.stringify(body)});
    let status:any; for(let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,2000)); status=await graph(`/${c.id}?fields=status_code,status`); if(status.status_code==='FINISHED') break; if(status.status_code==='ERROR') throw new Error(JSON.stringify(status)); }
    const p=await graph('/me/media_publish',{method:'POST',body:JSON.stringify({creation_id:c.id})});
    return {content:[{type:'text',text:JSON.stringify({container:c,status,published:p},null,2)}]};
  });
  m.tool('delete_media', 'Delete an Instagram media item when the connected API path permits it.', { media_id:z.string() }, async ({media_id}) => {
    const d=await graph(`/${encodeURIComponent(media_id)}`,{method:'DELETE'});
    return {content:[{type:'text',text:JSON.stringify(d,null,2)}]};
  });
  return m;
}

const app=express(); app.use(express.json({limit:'1mb'}));
app.get('/health',(_req,res)=>res.json({ok:true,service:'instagram-chatgpt-mcp'}));
app.get('/oauth/start',(_req,res)=>{
  if (!APP_ID || !APP_SECRET) return res.status(503).send('Meta app is not configured yet.');
  const verifier=pkceVerifier(), state=b64url(crypto.randomBytes(24));
  db.prepare('INSERT INTO oauth_state(state,verifier,created_at) VALUES(?,?,?)').run(state,verifier,Date.now());
  const u=new URL('https://www.instagram.com/oauth/authorize');
  u.searchParams.set('client_id',APP_ID); u.searchParams.set('redirect_uri',REDIRECT_URI); u.searchParams.set('response_type','code'); u.searchParams.set('scope','instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights'); u.searchParams.set('state',state); u.searchParams.set('code_challenge',challenge(verifier)); u.searchParams.set('code_challenge_method','S256');
  res.redirect(u.toString());
});
app.get('/oauth/callback',async(req,res)=>{
  try{
    const code=String(req.query.code||''); const state=String(req.query.state||''); const row=db.prepare('SELECT * FROM oauth_state WHERE state=?').get(state) as any;
    if(!code||!row) return res.status(400).send('Invalid OAuth state/code.');
    db.prepare('DELETE FROM oauth_state WHERE state=?').run(state);
    const body=new URLSearchParams({client_id:APP_ID,client_secret:APP_SECRET,grant_type:'authorization_code',redirect_uri:REDIRECT_URI,code});
    const r=await fetch('https://api.instagram.com/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    const d:any=await r.json(); if(!r.ok||!d.access_token) throw new Error(JSON.stringify(d));
    await exchangeAndSave(d.access_token);
    res.send('<h2>Instagram connected.</h2><p>You can close this tab and return to ChatGPT.</p>');
  }catch(e:any){res.status(500).send(`OAuth failed: ${escapeHtml(e?.message||String(e))}`);}
});
function escapeHtml(s:string){return s.replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]!));}

app.post('/mcp', async(req:Request,res:Response)=>{
  const auth = req.header('authorization') || '';
  if (auth !== `Bearer ${MCP_AUTH_TOKEN}`) return res.status(401).json({error:'Unauthorized'});
  try{
    const server=makeMcp();
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.on('close',()=>transport.close());
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }catch(e:any){ if(!res.headersSent) res.status(500).json({error:e?.message||String(e)}); }
});

app.listen(PORT,()=>console.log(`Instagram MCP listening on ${BASE} (MCP ${BASE}/mcp)`));
