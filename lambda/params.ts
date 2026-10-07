import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const PREFIX = process.env.PARAM_PREFIX ?? '/backlog-with-line';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: string; at: number }>();

/** SSM Parameter Store から値を取得（SecureString想定・Lambdaコンテキスト内でキャッシュ） */
export async function getParam(name: string): Promise<string> {
  const key = `${PREFIX}/${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const res = await ssm.send(
    new GetParameterCommand({ Name: key, WithDecryption: true }),
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter not found: ${key}`);
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function getParamOrNull(name: string): Promise<string | null> {
  try {
    return await getParam(name);
  } catch {
    return null;
  }
}

/** 値を保存（デフォルトSecureString。管理画面からBacklog APIキー登録に使用） */
export async function putParam(
  name: string,
  value: string,
  secure = true,
): Promise<void> {
  const key = `${PREFIX}/${name}`;
  await ssm.send(
    new PutParameterCommand({
      Name: key,
      Value: value,
      Type: secure ? 'SecureString' : 'String',
      Overwrite: true,
    }),
  );
  cache.delete(key);
}
