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
): Promise<{ userId: string } | { error: string }> {
  const channelId = await getParam('line/channel-id');
  const userId = await verifyIdToken(idToken, channelId);
  if (!userId) return { error: 'invalid_id_token' };
  const token = await getParam('line/channel-access-token');
  if (!(await isGroupMember(token, groupId, userId))) {
    return { error: 'not_group_member' };
  }
  return { userId };
}

const baseUrl = (c: { req: { header: (n: string) => string | undefined } }) =>
  `https://${c.req.header('host')}`;

// ---- 設定の読み込み ----
adminApp.get('/api/config', async (c) => {
  const groupId = c.req.query('groupId') ?? '';
  const idToken = c.req.query('idToken') ?? '';
  const auth = await authGroup(idToken, groupId);
  if ('error' in auth) return c.json({ error: auth.error }, 401);

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

// ---- 接続テスト（第1段階：spaceUrl + APIキー + projectKey で疎通確認してメタ情報を返す） ----
adminApp.post('/api/connect', async (c) => {
  const body = await c.req.json();
  const { idToken, groupId } = body;
  const auth = await authGroup(idToken, groupId ?? '');
  if ('error' in auth) return c.json({ error: auth.error }, 401);

  const spaceUrl = String(body.spaceUrl ?? '').replace(/\/$/, '');
  const projectKey = String(body.projectKey ?? '').toUpperCase();
  if (!spaceUrl || !projectKey || !body.backlogApiKey) {
    return c.json({ error: 'spaceUrl / projectKey / APIキーは必須です' }, 400);
  }
  await putParam(`groups/${groupId}/backlog-api-key`, body.backlogApiKey);

  const prev = await getGroupConfig(groupId);
  const cfg: GroupConfig = {
    groupId,
    spaceUrl,
    projectKey,
    webhookToken: prev?.webhookToken ?? crypto.randomUUID(),
    notifyTypes: prev?.notifyTypes ?? [3],
    priorityId: prev?.priorityId ?? 3,
  };
  try {
    await getMyself(cfg); // APIキー検証
    const issueTypes = await listIssueTypes(cfg); // projectId解決を兼ねる
    const [priorities, users] = await Promise.all([
      listPriorities(cfg),
      listProjectUsers(cfg),
    ]);
    await putGroupConfig(cfg);
    await putWebhookToken(cfg.webhookToken, groupId);
    return c.json({
      ok: true,
      meta: { issueTypes, priorities, users },
      webhookUrl: `${baseUrl(c)}/webhook/backlog/${cfg.webhookToken}`,
    });
  } catch (e) {
    return c.json({ error: `Backlog接続に失敗: ${(e as Error).message}` }, 400);
  }
});

// ---- 設定の保存 ----
adminApp.post('/api/config', async (c) => {
  const body = await c.req.json();
  const { idToken, groupId } = body;
  const auth = await authGroup(idToken, groupId ?? '');
  if ('error' in auth) return c.json({ error: auth.error }, 401);

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
  const auth = await authGroup(idToken, groupId);
  if ('error' in auth) return c.json({ error: auth.error }, 401);
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
  const auth = await authGroup(idToken, groupId ?? '');
  if ('error' in auth) return c.json({ error: auth.error }, 401);
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

const ERR_JA = {
  invalid_id_token: 'LINEログイン確認に失敗しました（LIFFのopenidスコープを確認してください）',
  not_group_member: 'グループメンバーとして確認できません。ボットをこのグループに招待してから開き直してください',
  unauthorized: '認証に失敗しました',
};
const msg = (t, err) => '<div class="msg'+(err?' err':'')+'">'+esc(ERR_JA[t]||t)+'</div>';

// ---- Step1: 接続テスト ----
function renderConnect(cfg) {
  app.innerHTML = '<h1>Backlog連携 設定</h1>'
    + '<p style="font-size:13px;color:#555">まず Backlog との接続を確認します</p>'
    + '<form>'
    + field('Backlog スペースURL','spaceUrl',cfg.spaceUrl,'url','https://xxx.backlog.com')
    + field('Backlog APIキー','backlogApiKey','','password')
    + field('プロジェクトキー','projectKey',cfg.projectKey,'text','SAGA')
    + '<button type="submit">接続テスト</button></form><div id="out"></div>';
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    $('#out').innerHTML = '接続中...';
    const v = formVals();
    const res = await fetch('/admin/api/connect', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ idToken, groupId, ...v }) });
    const j = await res.json();
    if (j.error) { $('#out').innerHTML = msg(j.error, true); return; }
    renderDetail({ spaceUrl: v.spaceUrl.replace(/[/]+$/,''), projectKey: v.projectKey.toUpperCase() }, j.meta, j.webhookUrl);
  };
}

// ---- Step2: 詳細設定（接続成功後にBacklogから取れた選択肢で表示） ----
function renderDetail(cfg, meta, webhookUrl) {
  const users = (meta.users||[]).map(u=>({id:u.id,name:u.name}));
  app.innerHTML = '<h1>Backlog連携 設定</h1>'
    + '<div class="msg">接続OK: '+esc(cfg.spaceUrl)+' / '+esc(cfg.projectKey)+'</div>'
    + '<form>'
    + selectField('課題タイプ','issueTypeId',meta.issueTypes||[],cfg.issueTypeId)
    + selectField('優先度','priorityId',meta.priorities||[],cfg.priorityId||3)
    + selectField('デフォルト担当者','assigneeId',users,cfg.assigneeId)
    + field('期限のデフォルト（日数・空なら未指定）','dueDays',cfg.dueDays??'','number')
    + '<label>起票テンプレート指示（任意）</label><textarea name="template" placeholder="例: 詳細は【概要】【再現手順】【期待結果】の見出しで整理する">'+esc(cfg.template||'')+'</textarea>'
    + '<label><input type="checkbox" name="notifyComment" '+(cfg.notifyTypes?.length?'checked':'')+' style="width:auto"> Backlogコメントをこのグループに通知</label>'
    + '<h2>LINE発言のミラー</h2>'
    + selectField('ミラーモード','mirrorMode',[{id:'off',name:'しない'},{id:'weekly',name:'週次ログ課題に記録'},{id:'fixed',name:'固定課題に記録'}],cfg.mirrorMode||'off')
    + field('固定課題キー（固定の場合）','mirrorIssueKey',cfg.mirrorIssueKey,'text','SAGA-123')
    + selectField('ミラー時のお知らせ先','mirrorNotifyUserId',users,cfg.mirrorNotifyUserId)
    + '<button type="submit">保存</button></form>'
    + '<button type="button" id="reconnect" style="background:#888;margin-top:8px">接続設定を変更</button><div id="out"></div>'
    + (webhookUrl ? '<h2>Backlog Webhook URL</h2><div class="msg">'+esc(webhookUrl)+'</div><p style="font-size:12px;color:#777">Backlogプロジェクト設定 → Webhook に登録してください</p>' : '');
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/admin/api/config', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ idToken, groupId, ...formVals(), notifyComment: !!$('[name=notifyComment]')?.checked }) });
    const j = await res.json();
    $('#out').innerHTML = j.error ? msg(j.error, true) : '<div class="msg">保存しました\\nWebhook URL: '+esc(j.webhookUrl)+'</div>';
    if (!j.error) renderSettings();
  };
  $('#reconnect').onclick = () => renderConnect(cfg);
}

async function renderSettings() {
  const q = new URLSearchParams({ groupId, idToken });
  const res = await fetch('/admin/api/config?'+q);
  const data = await res.json();
  if (data.error) { app.innerHTML = msg(data.error, true); return; }
  if (!data.config) { renderConnect({}); return; }
  renderDetail(data.config, data.meta || {}, data.webhookUrl);
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

const show = (t) => { app.innerHTML = t; };
const timeout = (ms, label) => new Promise((_, rj) => setTimeout(() => rj(new Error(label+'がタイムアウトしました')), ms));

(async () => {
  show('LIFF ID確認中...');
  if (!LIFF_ID) { show(msg('LIFF ID が未設定です（SSM: line/liff-id）', true)); return; }
  show('LIFF初期化中...');
  await Promise.race([liff.init({ liffId: LIFF_ID }), timeout(20000, 'LIFF初期化')]);
  if (!liff.isLoggedIn()) { show(msg('LINEにログインしていません', true)); return; }
  idToken = liff.getIDToken() || '';
  if (!idToken) { show(msg('IDトークンが取得できません（LIFFのopenidスコープを確認）', true)); return; }
  const ctx = liff.getContext();
  groupId = ctx && ctx.groupId || ctx && ctx.roomId || '';
  if (!groupId) { show(msg('グループ内のリンクから開いてください（コンテキスト: '+esc(ctx?.type||'なし')+'）', true)); return; }
  show('設定を取得中...');
  const draftId = new URLSearchParams(location.search).get('draft');
  if (draftId) await renderDraft(draftId); else await renderSettings();
})().catch(e => { show('<div class="msg err">'+esc(e && e.message || String(e))+'</div>'); });
</script>
</body>
</html>`);
});
