import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION ?? 'us-west-2',
});
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'deepseek.v3.2';

export interface IssueDraft {
  summary: string;
  description: string;
  dueDate: string | null;
}

/** メンション本文を起票テンプレートに沿って整形し、下書きJSONを返す */
export async function draftIssue(
  text: string,
  opts: { today: string; template?: string },
): Promise<IssueDraft> {
  const system = [
    'あなたはBacklog課題の起票アシスタントです。',
    'ユーザーのメモをBacklog課題に変換し、JSONのみを出力してください。',
    '出力形式: {"summary":"件名(簡潔)","description":"課題の詳細(Markdown可)","dueDate":"YYYY-MM-DD または null"}',
    `今日は ${opts.today} です。「来週金曜」等の相対表現は日付に変換してください。`,
    '期限が読み取れない場合は dueDate を null にしてください。',
    opts.template ? `課題テンプレートの指示:\n${opts.template}` : '',
    'JSON以外のテキストは出力しないでください。',
  ]
    .filter(Boolean)
    .join('\n');

  const res = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
    }),
  );

  const out =
    res.output?.message?.content
      ?.map((b) => ('text' in b ? b.text : ''))
      .join('') ?? '';
  const json = JSON.parse(out.replace(/```(?:json)?/g, '').trim());
  return {
    summary: String(json.summary ?? '').slice(0, 255) || text.slice(0, 60),
    description: String(json.description ?? text),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(json.dueDate) ? json.dueDate : null,
  };
}
