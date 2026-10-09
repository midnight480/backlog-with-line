import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME ?? '';
const ttlIn = (sec: number) => Math.floor(Date.now() / 1000) + sec;

export interface GroupConfig {
  groupId: string;
  spaceUrl: string; // https://xxx.backlog.com
  projectKey: string; // 例: SAGA
  projectId?: number; // 初回起票時に解決して保存
  assigneeId?: number; // デフォルト担当者（BacklogユーザーID）
  issueTypeId?: number;
  priorityId?: number; // 未指定時は 3（中）
  dueDays?: number; // 期限未指定時の日数オフセット（未設定なら期限なし）
  webhookToken: string; // Backlog Webhook URL用の秘密トークン
  notifyTypes: number[]; // 通知するBacklog Webhook種別（デフォルト [3]=コメント）
  template?: string; // 起票時にGrokへ渡すテンプレート指示
  botBacklogUserId?: number; // Backlog APIキー所有者（自分のコメント通知を抑制）
  mirrorMode?: 'off' | 'fixed' | 'weekly'; // 全発言ミラー
  mirrorIssueKey?: string; // fixed時の流し先課題キー
  mirrorNotifyUserId?: number; // ミラーコメント時のお知らせ対象ユーザーID
  mirrorLogIssueKey?: string; // 現在ローテーション中のログ課題
  mirrorLogPeriod?: string; // その期間ラベル（例: 2026-W41）
}

export interface Pending {
  kind: 'intent' | 'draft' | 'awaitNumber' | 'confirmComment';
  userId: string;
  text: string;
  summary?: string;
  description?: string;
  dueDate?: string | null;
  issueKey?: string;
  aiFormatted?: boolean;
}

async function getItem<T>(pk: string): Promise<T | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk } }),
  );
  return res.Item as T | undefined;
}

async function putItem(
  pk: string,
  item: Record<string, unknown>,
  ttlSec?: number,
): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: pk, ...item, ...(ttlSec ? { ttl: ttlIn(ttlSec) } : {}) },
    }),
  );
}

const deleteItem = (pk: string) =>
  doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk } }));

// ---- グループ設定 ----
export const getGroupConfig = (groupId: string) =>
  getItem<GroupConfig>(`GROUP#${groupId}`);
export const putGroupConfig = (cfg: GroupConfig) =>
  putItem(`GROUP#${cfg.groupId}`, cfg as unknown as Record<string, unknown>);

// ---- Backlog Webhookトークン → グループ逆引き ----
export async function getGroupByToken(token: string) {
  const ref = await getItem<{ groupId: string }>(`WBTOKEN#${token}`);
  return ref ? getGroupConfig(ref.groupId) : undefined;
}
export const putWebhookToken = (token: string, groupId: string) =>
  putItem(`WBTOKEN#${token}`, { groupId });

// ---- 保留中アクション（確認ボタン等） TTL: 10分 ----
export const putPending = (id: string, p: Pending) =>
  putItem(`PENDING#${id}`, p as unknown as Record<string, unknown>, 600);
export const getPending = (id: string) => getItem<Pending>(`PENDING#${id}`);
export const delPending = (id: string) => deleteItem(`PENDING#${id}`);

// ---- 入力待ち（課題番号の回答待ち） ----
export const setAwait = (groupId: string, userId: string, pendingId: string) =>
  putItem(`AWAIT#${groupId}#${userId}`, { pendingId }, 600);
export const getAwait = (groupId: string, userId: string) =>
  getItem<{ pendingId: string }>(`AWAIT#${groupId}#${userId}`);
export const delAwait = (groupId: string, userId: string) =>
  deleteItem(`AWAIT#${groupId}#${userId}`);

// ---- ボット発言 → 課題キー紐付け（返信でコメント。TTL: 30日） ----
export const linkMessage = (lineMessageId: string, issueKey: string) =>
  putItem(`MSG#${lineMessageId}`, { issueKey }, 60 * 60 * 24 * 30);
export const resolveMessage = (lineMessageId: string) =>
  getItem<{ issueKey: string }>(`MSG#${lineMessageId}`);

// ---- Webhookイベント冪等化（TTL: 24h） ----
export const isSeen = async (eventId: string) =>
  !!(await getItem(`SEEN#${eventId}`));
export const markSeen = (eventId: string) =>
  putItem(`SEEN#${eventId}`, {}, 86400);
