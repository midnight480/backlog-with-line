const LINE_API = 'https://api.line.me/v2/bot';
const LINE_OAUTH = 'https://api.line.me/oauth2/v2.1';

interface SentResult {
  sentMessages?: { id: string }[];
}

async function post(
  path: string,
  token: string,
  body: unknown,
): Promise<SentResult> {
  const res = await fetch(`${LINE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LINE API ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as SentResult;
}

/** 応答メッセージ（無料・通数カウント対象外） */
export const lineReply = (
  token: string,
  replyToken: string,
  messages: unknown[],
) => post('/message/reply', token, { replyToken, messages });

/** プッシュメッセージ（月間通数にカウント） */
export const linePush = (token: string, to: string, messages: unknown[]) =>
  post('/message/push', token, { to, messages });

export const textMsg = (text: string) => ({ type: 'text', text });

type Action = { label: string; data?: string; uri?: string };

/** ボタンテンプレート（postback / uri アクション。text は400文字制限） */
export function buttonsTemplate(
  altText: string,
  text: string,
  actions: Action[],
) {
  return {
    type: 'template',
    altText,
    template: {
      type: 'buttons',
      text: text.slice(0, 400),
      actions: actions.map((a) =>
        a.uri
          ? { type: 'uri', label: a.label, uri: a.uri }
          : { type: 'postback', label: a.label, data: a.data },
      ),
    },
  };
}

/** LIFFのIDトークンを検証し、ユーザーID(sub)を返す */
export async function verifyIdToken(
  idToken: string,
  channelId: string,
): Promise<string | null> {
  const res = await fetch(`${LINE_OAUTH}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { sub?: string };
  return json.sub ?? null;
}

/** ユーザーがそのグループのメンバーか確認（設定改ざん防止）
 *  注意: 未認証OAでは友だち追加済みメンバー以外が取れず失敗する場合がある */
export async function isGroupMember(
  token: string,
  groupId: string,
  userId: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    `${LINE_API}/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return { ok: res.ok, status: res.status, body: await res.text() };
}

const profileCache = new Map<string, { name: string; at: number }>();

/** グループ内での表示名を取得（ミラー記録の発言者名用・キャッシュ付き） */
export async function getMemberDisplayName(
  token: string,
  groupId: string,
  userId: string,
): Promise<string> {
  const key = `${groupId}:${userId}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.name;
  const res = await fetch(
    `${LINE_API}/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return '不明なユーザー';
  const json = (await res.json()) as { displayName?: string };
  const name = json.displayName ?? '不明なユーザー';
  profileCache.set(key, { name, at: Date.now() });
  return name;
}
