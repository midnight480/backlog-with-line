import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Grok 4.6 on Bedrock は us-west-2 の推論プロファイル経由で呼び出す
const BEDROCK_REGION = 'us-west-2';
const BEDROCK_MODEL_ID = 'us.xai.grok-4.6';
const PARAM_PREFIX = '/backlog-with-line';

export class BacklogWithLineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // グループ設定 / 保留中アクション / メッセージ紐付け / 冪等化を1テーブルで管理
    const table = new dynamodb.Table(this, 'StateTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const fn = new NodejsFunction(this, 'WebhookFn', {
      entry: path.join(__dirname, '../lambda/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        PARAM_PREFIX,
        BEDROCK_REGION,
        BEDROCK_MODEL_ID,
      },
      bundling: {
        // Node.js 22 ランタイム同梱の AWS SDK v3 を使う
        externalModules: ['@aws-sdk/*'],
      },
    });

    table.grantReadWriteData(fn);

    // SSM Parameter Store: /backlog-with-line/*（LINEチャネル情報・Backlog APIキー）
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${PARAM_PREFIX}/*`,
        ],
      }),
    );

    // Bedrock: 推論プロファイル + 配送先リージョンの基盤モデル
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${BEDROCK_REGION}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
          ...['us-east-1', 'us-east-2', 'us-west-2'].map(
            (r) => `arn:aws:bedrock:${r}::foundation-model/xai.grok-4.6`,
          ),
        ],
      }),
    );

    // LINE Webhook はIAM認証できないため公開URL + コード内で X-Line-Signature 検証
    const url = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    new cdk.CfnOutput(this, 'FunctionUrl', { value: url.url });
    new cdk.CfnOutput(this, 'AdminPageUrl', { value: `${url.url}admin` });
  }
}
