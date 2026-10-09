import crypto from 'node:crypto';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { adminApp } from './admin';
import * as backlog from './backlog';
import { draftIssue } from './grok';
import * as line from './line';
import { getParam, getParamOrNull } from './params';
import * as store from './store';

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true }));
app.route('/admin', adminApp);

const truncate = (s: unknown, n = 200) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** メンション表記をテキストから除去 */
function stripMentions(text: string, mention: any): string {
  const ms = [...(mention?.mentionees ?? [])].sort(
    (a, b) => b.index - a.index,
  );
  let t = text;
  for (const m of ms) t = t.slice(0, m.index) + t.slice(m.index + m.length);
  return t;
}

// ================= Backlog → LINE =================
app.post('/webhook/backlog/:token', async (c) => {
  const cfg = await store.getGroupByToken(c.req.param('token'));
  if (!cfg) return c.json({ error: 'unknown token' }, 404);

  const payload = await c.req.json();
  console.log(
    'backlog webhook',
    JSON.stringify({
      type: payload.type,
      commenter:
        payload.createdUser?.id ?? payload.content?.comment?.createdUser?.id,
      notifyTypes: cfg.notifyTypes,
    }),
  );
  if (!cfg.notifyTypes?.includes(payload.type)) {
    return c.json({ ok: true, skipped: 'type' });
  }
  // ボット自身(APIキー所有者)のコメントはループするので通知しない
  const actorId =
    payload.createdUser?.id ?? payload.content?.comment?.createdUser?.id;
  const me = await backlog.getMyself(cfg).catch(() => null);
  if (me && actorId === me.id) {
    console.log(`backlog webhook skipped: self (me=${me.id})`);
    return c.json({ ok: true, skipped: 'self' });
  }

  const issueKey = payload.content?.key_id
    ? `${payload.project?.projectKey}-${payload.content.key_id}`
    : '';
  const comment = payload.content?.comment?.content ?? '';
  const text =
    `Backlog更新: ${issueKey} にコメント\n` +
    `${payload.createdUser?.name ?? ''}: ${truncate(comment, 300)}\n` +
    `${cfg.spaceUrl}/view/${issueKey}#comment-${payload.content?.comment?.id ?? ''}`;

  const token = await getParam('line/channel-access-token');
  await line.linePush(token, cfg.groupId, [line.textMsg(text)]);
  return c.json({ ok: true });
});

// ================= LINE → Backlog =================
app.post('/webhook/line', async (c) => {
  // 入り口で署名検証: 合わないものは即捨て
  const secret = await getParam('line/channel-secret');
  const signature = c.req.header('x-line-signature') ?? '';
  const body = await c.req.text();
  const digest = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');
  const ok =
    digest.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  const { events = [] } = JSON.parse(body);
  console.log(
    'line webhook',
    JSON.stringify(
      events.map((e: any) => ({
        type: e.type,
        src: e.source?.type,
        msg: e.message?.type,
        mention: e.message?.mention?.mentionees?.map((m: any) => m.isSelf),
      })),
    ),
  );
  const token = await getParam('line/channel-access-token');
  const baseUrl = `https://${c.req.header('host')}`;

  for (const ev of events) {
    if (ev.webhookEventId) {
      if (await store.isSeen(ev.webhookEventId)) continue;
      await store.markSeen(ev.webhookEventId);
    }
    try {
      await handleEvent(ev, { token, baseUrl });
    } catch (e) {
      console.error('event error', JSON.stringify(ev), e);
    }
  }
  return c.json({ ok: true });
});

interface Ctx {
  token: string;
  baseUrl: string;
}

async function handleEvent(ev: any, ctx: Ctx) {
  const groupId: string | undefined =
    ev.source?.groupId ?? ev.source?.roomId;

  if (ev.type === 'join' && ev.replyToken) {
    const liffId = await getParamOrNull('line/liff-id');
    const adminUrl = liffId
      ? `https://liff.line.me/${liffId}/?group=${groupId}`
      : `${ctx.baseUrl}/admin?group=${groupId}`;
    await line.lineReply(ctx.token, ev.replyToken, [
      line.textMsg(
        'Backlog連携ボットです。\n\n' +
          `管理者の方はまず設定画面でBacklogプロジェクトと紐付けてください:\n${adminUrl}\n\n` +
          '使い方: このボットにメンション付きでメモを送ると、新規起票 or 既存課題へのコメントを選べます。',
      ),
    ]);
    return;
  }

  const userId: string | undefined = ev.source?.userId;
  if (!groupId || !userId) return;

  if (ev.type === 'message') {
    // 全発言ミラー（失敗してもコマンド処理は継続）
    const cfg = await store.getGroupConfig(groupId);
    if (cfg?.mirrorMode && cfg.mirrorMode !== 'off') {
      try {
        await mirrorMessage(ev, cfg, ctx, groupId, userId);
      } catch (e) {
        console.error('mirror error', e);
      }
    }
    if (ev.message?.type === 'text') {
      await onText(ev, ctx, groupId, userId, cfg);
    }
  } else if (ev.type === 'postback' && ev.replyToken) {
    await onPostback(ev, ctx, groupId, userId);
  }
}

// ================= 全発言ミラー =================

/** JSTでの週ラベル（その週の月曜日付。例: 2026-10-05週） */
function weekLabel(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = (jst.getUTCDay() + 6) % 7; // 月曜=0
  const monday = new Date(jst.getTime() - day * 86400000);
  return `${monday.toISOString().slice(0, 10)}週`;
}

/** ミラー先の課題キーを解決（週次モードでは必要に応じてログ課題を自動起票） */
async function resolveMirrorIssue(
  cfg: store.GroupConfig,
): Promise<string | null> {
  if (cfg.mirrorMode === 'fixed') return cfg.mirrorIssueKey ?? null;
  if (cfg.mirrorMode !== 'weekly') return null;

  const label = weekLabel(new Date());
  if (cfg.mirrorLogIssueKey && cfg.mirrorLogPeriod === label) {
    return cfg.mirrorLogIssueKey;
  }
  const issue = await backlog.createIssue(cfg, {
    summary: `LINEログ ${label}`,
    description: 'この課題にはLINEグループの発言が自動記録されます。',
    footer: backlog.MIRROR_FOOTER,
  });
  cfg.mirrorLogIssueKey = issue.issueKey as string;
  cfg.mirrorLogPeriod = label;
  await store.putGroupConfig(cfg);
  return issue.issueKey as string;
}

function describeMessage(msg: any): string {
  switch (msg?.type) {
    case 'text':
      return msg.text;
    case 'sticker':
      return '[スタンプ]';
    case 'image':
      return '[画像]';
    case 'video':
      return '[動画]';
    case 'audio':
      return '[音声]';
    case 'file':
      return `[ファイル] ${msg.fileName ?? ''}`.trim();
    case 'location':
      return `[位置情報] ${msg.title ?? ''} ${msg.address ?? ''}`.trim();
    default:
      return `[${msg?.type ?? '不明なメッセージ'}]`;
  }
}

async function mirrorMessage(
  ev: any,
  cfg: store.GroupConfig,
  ctx: Ctx,
  groupId: string,
  userId: string,
) {
  const issueKey = await resolveMirrorIssue(cfg);
  if (!issueKey) return;
  const name = await line.getMemberDisplayName(ctx.token, groupId, userId);
  const when = new Date(ev.timestamp ?? Date.now()).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
  });
  await backlog.addComment(
    cfg,
    issueKey,
    `${when} ${name}\n${describeMessage(ev.message)}`,
    {
      notifiedUserIds: cfg.mirrorNotifyUserId
        ? [cfg.mirrorNotifyUserId]
        : undefined,
      footer: backlog.MIRROR_FOOTER,
    },
  );
}

async function onText(
  ev: any,
  ctx: Ctx,
  groupId: string,
  userId: string,
  cfg?: store.GroupConfig,
) {
  const text: string = ev.message.text ?? '';
  cfg = cfg ?? (await store.getGroupConfig(groupId));

  // 1. 課題番号の入力待ち
  const awaiting = await store.getAwait(groupId, userId);
  if (awaiting) {
    await store.delAwait(groupId, userId);
    const num = text.match(/\d+/)?.[0];
    const pend = await store.getPending(awaiting.pendingId);
    if (pend && num && cfg) {
      pend.kind = 'confirmComment';
      pend.issueKey = `${cfg.projectKey}-${num}`;
      await store.putPending(awaiting.pendingId, pend);
      await line.lineReply(ctx.token, ev.replyToken, [
        line.buttonsTemplate('コメント確認', `以下の内容で ${pend.issueKey} にコメントしますか？\n\n${truncate(pend.text)}`, [
          { label: '投稿する', data: `a=confirm_comment&p=${awaiting.pendingId}` },
          { label: 'キャンセル', data: `a=cancel&p=${awaiting.pendingId}` },
        ]),
      ]);
      return;
    }
    // 数字が取れない/期限切れ → 通常処理へフォールスルー
  }

  // 2. ボット発言への返信 → その課題へそのままコメント
  const quotedId: string | undefined = ev.message.quotedMessageId;
  if (quotedId && cfg) {
    const link = await store.resolveMessage(quotedId);
    const clean = stripMentions(text, ev.message.mention).trim();
    if (link && clean) {
      await backlog.addComment(cfg, link.issueKey, clean);
      const res = await line.lineReply(ctx.token, ev.replyToken, [
        line.textMsg(
          `${link.issueKey} にコメントしました\n${cfg.spaceUrl}/view/${link.issueKey}`,
        ),
      ]);
      const sentId = res.sentMessages?.[0]?.id;
      if (sentId) await store.linkMessage(sentId, link.issueKey);
      return;
    }
  }

  // 3. ボットへのメンション → 起票/コメントの選択
  const isSelf = ev.message.mention?.mentionees?.some(
    (m: any) => m.isSelf === true,
  );
  if (!isSelf) return;

  const clean = stripMentions(text, ev.message.mention).trim();
  if (!cfg) {
    const liffId = await getParamOrNull('line/liff-id');
    const adminUrl = liffId
      ? `https://liff.line.me/${liffId}/?group=${groupId}`
      : `${ctx.baseUrl}/admin?group=${groupId}`;
    await line.lineReply(ctx.token, ev.replyToken, [
      line.textMsg(
        `このグループはまだBacklogと紐付いていません。設定画面で登録してください:\n${adminUrl}`,
      ),
    ]);
    return;
  }
  if (!clean) {
    await line.lineReply(ctx.token, ev.replyToken, [
      line.textMsg(
        'メンションと一緒にメモを送ってください。新規起票 or 既存課題へのコメントを選べます。',
      ),
    ]);
    return;
  }

  const pid = crypto.randomUUID();
  await store.putPending(pid, { kind: 'intent', text: clean, userId });
  await line.lineReply(ctx.token, ev.replyToken, [
    line.buttonsTemplate('操作を選択', `このメッセージをどうしますか？\n\n${truncate(clean)}`, [
      { label: '新規起票', data: `a=new&p=${pid}` },
      { label: '既存課題にコメント', data: `a=comment&p=${pid}` },
      { label: 'キャンセル', data: `a=cancel&p=${pid}` },
    ]),
  ]);
}

async function onPostback(
  ev: any,
  ctx: Ctx,
  groupId: string,
  userId: string,
) {
  const params = new URLSearchParams(ev.postback?.data ?? '');
  const action = params.get('a') ?? '';
  const pid = params.get('p') ?? '';
  const reply = (msgs: unknown[]) =>
    line.lineReply(ctx.token, ev.replyToken, msgs);

  if (action === 'cancel') {
    await store.delPending(pid);
    await reply([line.textMsg('キャンセルしました')]);
    return;
  }

  const [pend, cfg] = await Promise.all([
    store.getPending(pid),
    store.getGroupConfig(groupId),
  ]);
  if (!pend || !cfg) {
    await reply([
      line.textMsg('この操作は期限切れか、グループが未設定です'),
    ]);
    return;
  }
  if (pend.userId !== userId) {
    await reply([
      line.textMsg('この操作はメンションした本人のみ実行できます'),
    ]);
    return;
  }

  switch (action) {
    case 'new': {
      // Grok 4.6 でテンプレートに沿った下書きを生成（失敗時は未整形で継続）
      const today = new Date().toLocaleDateString('sv-SE', {
        timeZone: 'Asia/Tokyo',
      });
      let draft: {
        summary?: string;
        description?: string;
        dueDate?: string | null;
      };
      let draftWarn = '';
      try {
        draft = await draftIssue(String(pend.text), {
          today,
          template: cfg.template,
        });
      } catch (e) {
        console.error('grok draft failed', e);
        draftWarn = '※AI整形に失敗したため未整形の下書きです\n';
        const t = String(pend.text);
        draft = {
          summary: t.split('\n')[0].slice(0, 80) || 'LINEからの起票',
          description: t,
        };
      }
      const due =
        draft.dueDate ??
        (cfg.dueDays
          ? new Date(Date.now() + cfg.dueDays * 86400000)
              .toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
          : null);
      Object.assign(pend, draft, {
        kind: 'draft' as const,
        dueDate: due,
        aiFormatted: !draftWarn,
      });
      await store.putPending(pid, pend);

      const liffId = await getParamOrNull('line/liff-id');
      const actions = [
        { label: 'この内容で起票', data: `a=confirm_create&p=${pid}` },
        ...(liffId
          ? [
              {
                label: 'フォームで修正',
                uri: `https://liff.line.me/${liffId}/?draft=${pid}&group=${groupId}`,
              },
            ]
          : []),
        { label: 'キャンセル', data: `a=cancel&p=${pid}` },
      ];
      await reply([
        line.buttonsTemplate(
          '起票プレビュー',
          `${draftWarn}【起票プレビュー】\n件名: ${draft.summary}\n期限: ${due ?? '未設定'}\n詳細:\n${truncate(draft.description, 250)}`,
          actions,
        ),
      ]);
      return;
    }

    case 'comment': {
      pend.kind = 'awaitNumber';
      await store.putPending(pid, pend);
      await store.setAwait(groupId, userId, pid);
      await reply([
        line.textMsg(
          `コメントする課題番号を入力してください（例: 123 → ${cfg.projectKey}-123）\n\n本文:\n${truncate(pend.text)}`,
        ),
      ]);
      return;
    }

    case 'confirm_create': {
      const issue = await backlog.createIssue(cfg, {
        summary: String(pend.summary),
        description: String(pend.description),
        dueDate: pend.dueDate ?? null,
        footer: pend.aiFormatted ? undefined : backlog.MIRROR_FOOTER,
      });
      await store.delPending(pid);
      const res = await reply([
        line.textMsg(
          `起票しました: ${issue.issueKey}\n${issue.summary}\n${cfg.spaceUrl}/view/${issue.issueKey}\n\nこのメッセージに返信するとコメントを追記できます`,
        ),
      ]);
      const sentId = res.sentMessages?.[0]?.id;
      if (sentId) await store.linkMessage(sentId, issue.issueKey as string);
      return;
    }

    case 'confirm_comment': {
      const issueKey = String(pend.issueKey);
      await backlog.addComment(cfg, issueKey, String(pend.text));
      await store.delPending(pid);
      const res = await reply([
        line.textMsg(
          `${issueKey} にコメントしました\n${cfg.spaceUrl}/view/${issueKey}`,
        ),
      ]);
      const sentId = res.sentMessages?.[0]?.id;
      if (sentId) await store.linkMessage(sentId, issueKey);
      return;
    }

    default:
      await reply([line.textMsg('不明な操作です')]);
  }
}

export const handler = handle(app);
