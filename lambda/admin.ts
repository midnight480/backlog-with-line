import crypto from 'node:crypto';
import { Hono } from 'hono';
import {
  createIssue,
  getMyself,
  listIssueTypes,
  listPriorities,
  listProjectUsers,
} from './backlog';
import { isGroupMember, linePush, textMsg, verifyIdToken } from './line';
import { getParam, getParamOrNull, putParam } from './params';
import {
  delPending,
  getGroupConfig,
  getPending,
  linkMessage,
  putGroupConfig,
  putWebhookToken,
  type GroupConfig,
} from './store';

export const adminApp = new Hono();

/** LIFFのIDトークン検証 + グループメンバー確認 */
async function authGroup(
  idToken: string,
  groupId: string,
): Promise<string | null> {
  const channelId = await getParam('line/channel-id');
  const userId = await verifyIdToken(idToken, channelId);
  if (!userId) return null;
  const token = await getParam('line/channel-access-token');
  return (await isGroupMember(token, groupId, userId)) ? userId : null;
}

const baseUrl = (c: { req: { header: (n: string) => string | undefined } }) =>
  `https://${c.req.header('host')}`;

// ---- 設定の読み込み ----
adminApp.get('/api/config', async (c) => {
  const groupId = c.req.query('groupId') ?? '';
  const idToken = c.req.query('idToken') ?? '';
  if (!(await authGroup(idToken, groupId))) return c.json({ error: 'unauthorized' }, 401);

  const cfg = await getGroupConfig(groupId);
  let meta: Record<string, unknown> = {};
  if (cfg) {
    try {
      const [issueTypes, priorities, users] = await Promise.all([
        listIssueTypes(cfg),
        listPriorities(cfg),
        listProjectUsers(cfg),
      ]);
      meta = { issueTypes, priorities, users };
    } catch {
      meta = { metaError: 'Backlog APIの呼び出しに失敗しました（URL/APIキー/プロジェクトキーを確認）' };
    }
  }
  const hasApiKey = !!(await getParamOrNull(`groups/${groupId}/backlog-api-key`));
  return c.json({
    config: cfg ?? null,
    hasApiKey,
    meta,
    webhookUrl: cfg ? `${baseUrl(c)}/webhook/backlog/${cfg.webhookToken}` : null,
  });
});

// ---- 設定の保存 ----
adminApp.post('/api/config', async (c) => {
  const body = await c.req.json();
  const { idToken, groupId } = body;
  if (!groupId || !(await authGroup(idToken, groupId))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  if (body.backlogApiKey) {
    await putParam(`groups/${groupId}/backlog-api-key`, body.backlogApiKey);
  }
  if (!(await getParamOrNull(`groups/${groupId}/backlog-api-key`))) {
    return c.json({ error: 'Backlog APIキーが未設定です' }, 400);
  }

  const prev = await getGroupConfig(groupId);
  const cfg: GroupConfig = {
    groupId,
    spaceUrl: String(body.spaceUrl ?? prev?.spaceUrl ?? '').replace(/\/$/, ''),
    projectKey: String(body.projectKey ?? prev?.projectKey ?? '').toUpperCase(),
    assigneeId: body.assigneeId ? Number(body.assigneeId) : undefined,
    issueTypeId: body.issueTypeId ? Number(body.issueTypeId) : undefined,
    priorityId: body.priorityId ? Number(body.priorityId) : 3,
    dueDays: body.dueDays ? Number(body.dueDays) : undefined,
    webhookToken: prev?.webhookToken ?? crypto.randomUUID(),
    notifyTypes: body.notifyComment === false ? [] : [3],
    template: body.template || undefined,
    projectId: prev?.projectKey === body.projectKey ? prev?.projectId : undefined,
    mirrorMode: ['off', 'fixed', 'weekly'].includes(body.mirrorMode)
      ? body.mirrorMode
      : 'off',
    mirrorIssueKey: body.mirrorIssueKey
      ? String(body.mirrorIssueKey).toUpperCase()
      : undefined,
    mirrorNotifyUserId: body.mirrorNotifyUserId
      ? Number(body.mirrorNotifyUserId)
      : undefined,
    mirrorLogIssueKey: prev?.mirrorLogIssueKey,
    mirrorLogPeriod: prev?.mirrorLogPeriod,
  };
  if (!cfg.spaceUrl || !cfg.projectKey || !cfg.issueTypeId) {
    return c.json({ error: 'spaceUrl / projectKey / issueTypeId は必須です' }, 400);
  }

  try {
    await getMyself(cfg); // APIキー・接続の検証を兼ねる
  } catch (e) {
    return c.json({ error: `Backlog接続に失敗: ${(e as Error).message}` }, 400);
  }

  await putGroupConfig(cfg);
  await putWebhookToken(cfg.webhookToken, groupId);
  return c.json({
    ok: true,
    webhookUrl: `${baseUrl(c)}/webhook/backlog/${cfg.webhookToken}`,
  });
});

// ---- 起票下書きの取得（LIFFフォーム編集用） ----
adminApp.get('/api/draft', async (c) => {
  const id = c.req.query('id') ?? '';
  const groupId = c.req.query('groupId') ?? '';
  const idToken = c.req.query('idToken') ?? '';
  if (!(await authGroup(idToken, groupId))) return c.json({ error: 'unauthorized' }, 401);
  const pend = await getPending(id);
  if (!pend || pend.kind !== 'draft') return c.json({ error: '期限切れです' }, 404);
  const cfg = await getGroupConfig(groupId);
  const meta = cfg
    ? await Promise.all([
        listIssueTypes(cfg).catch(() => []),
        listPriorities(cfg).catch(() => []),
        listProjectUsers(cfg).catch(() => []),
      ]).then(([issueTypes, priorities, users]) => ({ issueTypes, priorities, users }))
    : {};
  return c.json({ draft: pend, config: cfg, meta });
});

// ---- 下書きを確定して起票（LIFFフォームから） ----
adminApp.post('/api/draft/submit', async (c) => {
  const body = await c.req.json();
  const { id, idToken, groupId } = body;
  if (!(await authGroup(idToken, groupId))) return c.json({ error: 'unauthorized' }, 401);
  const pend = await getPending(id);
  const cfg = await getGroupConfig(groupId);
  if (!pend || !cfg) return c.json({ error: '期限切れか未設定です' }, 404);

  const issue = await createIssue(cfg, {
    summary: String(body.summary ?? pend.summary),
    description: String(body.description ?? pend.description),
    dueDate: body.dueDate || null,
    issueTypeId: body.issueTypeId ? Number(body.issueTypeId) : undefined,
    priorityId: body.priorityId ? Number(body.priorityId) : undefined,
    assigneeId: body.assigneeId ? Number(body.assigneeId) : undefined,
  });
  await delPending(id);

  // グループへ結果を通知（プッシュ：月間通数にカウント）
  const token = await getParam('line/channel-access-token');
  const res = await linePush(token, groupId, [
    textMsg(
      `起票しました: ${issue.issueKey}\n${issue.summary}\n${cfg.spaceUrl}/view/${issue.issueKey}\n\nこのメッセージに返信するとコメントを追記できます`,
    ),
  ]);
  const sentId = res.sentMessages?.[0]?.id;
  if (sentId) await linkMessage(sentId, issue.issueKey as string);
  return c.json({ ok: true, issueKey: issue.issueKey });
});

// ---- LIFF ページ本体 ----
adminApp.get('/', async (c) => {
  const liffId = (await getParamOrNull('line/liff-id')) ?? '';
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backlog連携 設定</title>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<style>
body{font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:16px;color:#222}
label{display:block;font-size:13px;margin:14px 0 4px;color:#555}
input,select,textarea{width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;font-size:15px}
textarea{min-height:100px}
button{margin-top:20px;width:100%;padding:12px;background:#06c755;color:#fff;border:none;border-radius:8px;font-size:16px}
.msg{margin-top:16px;padding:10px;border-radius:6px;background:#f0f9f1;font-size:14px;white-space:pre-wrap;word-break:break-all}
.err{background:#fdeeee}
h1{font-size:18px}h2{font-size:15px;margin-top:24px}
</style>
</head>
<body>
<div id="app">読み込み中...</div>
<script>
const LIFF_ID = ${JSON.stringify(liffId)};
const $ = (s) => document.querySelector(s);
const app = $('#app');
let idToken = '', groupId = '';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));

function field(label, name, val, type='text', placeholder='') {
  return '<label>'+esc(label)+'</label><input name="'+name+'" type="'+type+'" value="'+esc(val)+'" placeholder="'+esc(placeholder)+'">';
}
function selectField(label, name, options, current) {
  const opts = '<option value="">（未選択）</option>' + options.map(o =>
    '<option value="'+o.id+'"'+(String(o.id)===String(current)?' selected':'')+'>'+esc(o.name)+'</option>').join('');
  return '<label>'+esc(label)+'</label><select name="'+name+'">'+opts+'</select>';
}
const formVals = () => Object.fromEntries(new FormData($('form')).entries());

async function renderSettings() {
  const q = new URLSearchParams({ groupId, idToken });
  const data = await (await fetch('/admin/api/config?'+q)).json();
  const cfg = data.config || {};
  const meta = data.meta || {};
  app.innerHTML = '<h1>Backlog連携 設定</h1>'
    + '<form>'
    + field('Backlog スペースURL','spaceUrl',cfg.spaceUrl,'url','https://xxx.backlog.com')
    + field('Backlog APIキー'+(data.hasApiKey?'（設定済・変更時のみ入力）':''),'backlogApiKey','','password')
    + field('プロジェクトキー','projectKey',cfg.projectKey,'text','SAGA')
    + selectField('課題タイプ','issueTypeId',meta.issueTypes||[],cfg.issueTypeId)
    + selectField('優先度','priorityId',meta.priorities||[],cfg.priorityId||3)
    + selectField('デフォルト担当者','assigneeId',(meta.users||[]).map(u=>({id:u.id,name:u.name})),cfg.assigneeId)
    + field('期限のデフォルト（日数・空なら未指定）','dueDays',cfg.dueDays??'','number')
    + '<label>起票テンプレート指示（任意）</label><textarea name="template" placeholder="例: 詳細は【概要】【再現手順】【期待結果】の見出しで整理する">'+esc(cfg.template||'')+'</textarea>'
    + '<label><input type="checkbox" name="notifyComment" '+(cfg.notifyTypes?.length?'checked':'')+' style="width:auto"> Backlogコメントをこのグループに通知</label>'
    + '<h2>LINE発言のミラー</h2>'
    + selectField('ミラーモード','mirrorMode',[{id:'off',name:'しない'},{id:'weekly',name:'週次ログ課題に記録'},{id:'fixed',name:'固定課題に記録'}],cfg.mirrorMode||'off')
    + field('固定課題キー（固定の場合）','mirrorIssueKey',cfg.mirrorIssueKey,'text','SAGA-123')
    + selectField('ミラー時のお知らせ先','mirrorNotifyUserId',(meta.users||[]).map(u=>({id:u.id,name:u.name})),cfg.mirrorNotifyUserId)
    + '<button type="submit">保存</button></form><div id="out"></div>'
    + (data.webhookUrl ? '<h2>Backlog Webhook URL</h2><div class="msg">'+esc(data.webhookUrl)+'</div><p style="font-size:12px;color:#777">Backlogプロジェクト設定 → Webhook に登録してください</p>' : '');
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/admin/api/config', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ idToken, groupId, ...formVals(), notifyComment: !!$('[name=notifyComment]')?.checked }) });
    const j = await res.json();
    $('#out').innerHTML = '<div class="msg'+(j.error?' err':'')+'">'+esc(j.error||('保存しました\\nWebhook URL: '+j.webhookUrl))+'</div>';
    if (!j.error) renderSettings();
  };
}

async function renderDraft(draftId) {
  const q = new URLSearchParams({ id: draftId, groupId, idToken });
  const data = await (await fetch('/admin/api/draft?'+q)).json();
  if (data.error) { app.innerHTML = '<div class="msg err">'+esc(data.error)+'</div>'; return; }
  const d = data.draft, meta = data.meta || {}, cfg = data.config || {};
  app.innerHTML = '<h1>起票内容の編集</h1>'
    + '<form>'
    + field('件名','summary',d.summary)
    + '<label>詳細</label><textarea name="description">'+esc(d.description)+'</textarea>'
    + field('期限','dueDate',d.dueDate||'','date')
    + selectField('課題タイプ','issueTypeId',meta.issueTypes||[],cfg.issueTypeId)
    + selectField('優先度','priorityId',meta.priorities||[],cfg.priorityId||3)
    + selectField('担当者','assigneeId',(meta.users||[]).map(u=>({id:u.id,name:u.name})),cfg.assigneeId)
    + '<button type="submit">この内容で起票</button></form><div id="out"></div>';
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/admin/api/draft/submit', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id: draftId, idToken, groupId, ...formVals() }) });
    const j = await res.json();
    $('#out').innerHTML = '<div class="msg'+(j.error?' err':'')+'">'+esc(j.error||('起票しました: '+j.issueKey))+'</div>';
    if (!j.error) setTimeout(() => liff.closeWindow(), 1500);
  };
}

(async () => {
  if (!LIFF_ID) { app.innerHTML = '<div class="msg err">LIFF ID が未設定です（SSM: line/liff-id）</div>'; return; }
  await liff.init({ liffId: LIFF_ID });
  idToken = liff.getIDToken() || '';
  const ctx = liff.getContext();
  groupId = ctx && ctx.groupId || ctx && ctx.roomId || '';
  if (!groupId) { app.innerHTML = '<div class="msg err">グループ内のリンクから開いてください</div>'; return; }
  const draftId = new URLSearchParams(location.search).get('draft');
  if (draftId) await renderDraft(draftId); else await renderSettings();
})().catch(e => { app.innerHTML = '<div class="msg err">'+esc(e.message)+'</div>'; });
</script>
</body>
</html>`);
});
